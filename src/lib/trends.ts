/* トレンドキーワード: 直近24時間の投稿+コメントを AI(さくらのAI Engine) で解析し、
 * 「実際に検索結果が出るキーワード」だけを検索バリデーションで絞り込んで 5件 保存する。
 * 6時間ごとに自動再生成（ensureTrendSweeper）。単一 Node プロセス前提。
 */
import { pool } from "./db";
import { sakuraChat } from "./sakura";

const RECENT_WINDOW = "24 hours";
const TREND_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
const STALE_MS = 5 * 60 * 60 * 1000; // 5h 以上古い/空なら生成
const MAX_TRENDS = 5;

let trendSweeperStarted = false;

export interface TrendKeyword {
  keyword: string;
  rank: number;
  hits: number;
  generatedAt?: string; // ISO
}

/** ILIKE で意味を持つ `%` `_` をエスケープする（ワイルドカード誤爆防止）。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** 直近24時間の投稿+コメントをまとめる。 */
async function collectRecentText(): Promise<{ text: string; count: number }> {
  const res = await pool.query(
    `SELECT COALESCE(author_name, '') AS author, text
       FROM posts
      WHERE created_at >= now() - interval '${RECENT_WINDOW}'
        AND text IS NOT NULL AND length(trim(text)) > 0`
  );
  const rows = res.rows as { author: string; text: string }[];
  return { text: rows.map((r) => `${r.author}: ${r.text}`).join("\n"), count: rows.length };
}

/** 直近24時間の投稿/コメントに、そのキーワードで一致する件数（検索ヒット数）。 */
async function countHits(keyword: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n
       FROM posts
      WHERE created_at >= now() - interval '${RECENT_WINDOW}'
        AND text ILIKE $1`,
    [`%${escapeLike(keyword)}%`]
  );
  return (res.rows[0] as { n: number }).n ?? 0;
}

/** AI に候補キーワード（20個以内・本文実在のみ）を抽出させる。 */
async function extractCandidateKeywords(text: string): Promise<string[]> {
  const system = `あなたはSNSタイムラインの解析者です。与えられた投稿・コメント本文から、トレンド検索キーワードとして価値のあるものだけを抽出してください。
ルール:
- 本文に「実際に登場している」語（固有名詞・製品名・サービス名・技術用語・人名・イベント名）だけを選ぶ。本文に無い語を推測・補完しない。
- 曖昧すぎる一般語（「AI」「コード」「アプリ」「開発」など単体）は避け、具体的な固有名詞を優先する。
- 日本語・英語どちらでもよい。
- 出力は各キーワードを1行につき1つだけ、番号・記号・カンマなしで最大20個。`;
  const res = await sakuraChat({
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: `以下が直近24時間の投稿・コメント一覧です。トレンドキーワードを抽出してください。\n\n---\n${text.slice(0, 60000)}\n---`,
      },
    ],
    max_tokens: 800,
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of res.content.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*•·\d.).]+\s*/, "") // 番号/箇条書き記号を除去
      .replace(/[#＃]\s*/, "") // 先頭ハッシュタグ除去
      .trim();
    if (line.length < 2 || line.length > 40) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/** 再生成: 解析→AI抽出→検索バリデーション→上位5件をDBに保存。 */
export async function generateTrendKeywords(): Promise<TrendKeyword[]> {
  const { text, count } = await collectRecentText();
  if (count < 2) return []; // アクティビティ不足
  const candidates = await extractCandidateKeywords(text);
  const lowerText = text.toLowerCase();

  // バリデーション: (1) 本文に実際に存在 (2) 検索で1件以上ヒット → 検索結果が出るキーワードだけ残す
  const scored: { keyword: string; hits: number }[] = [];
  for (const kw of candidates) {
    if (!lowerText.includes(kw.toLowerCase())) continue; // ハルシネーション・無関係キーワード除去
    const hits = await countHits(kw);
    if (hits > 0) scored.push({ keyword: kw, hits });
  }
  scored.sort((a, b) => b.hits - a.hits);
  const top = scored.slice(0, MAX_TRENDS);

  await pool.query(`TRUNCATE trend_keywords`);
  for (let i = 0; i < top.length; i++) {
    await pool.query(
      `INSERT INTO trend_keywords (keyword, rank, hits) VALUES ($1, $2, $3)`,
      [top[i].keyword, i + 1, top[i].hits]
    );
  }
  return top.map((t, i) => ({
    keyword: t.keyword,
    rank: i + 1,
    hits: t.hits,
    generatedAt: new Date().toISOString(),
  }));
}

/** 保存済みトレンド上位を取得（DB読みのみ・AI呼び出しなし=毎リクエスト高速）。 */
export async function getTrendKeywords(): Promise<TrendKeyword[]> {
  const res = await pool.query(
    `SELECT keyword, rank, hits, generated_at AS "generatedAt"
       FROM trend_keywords
      ORDER BY rank ASC
      LIMIT $1`,
    [MAX_TRENDS]
  );
  return (res.rows as Array<{ keyword: string; rank: number; hits: number; generatedAt: Date }>).map(
    (r) => ({ keyword: r.keyword, rank: r.rank, hits: r.hits, generatedAt: r.generatedAt.toISOString() })
  );
}

/** 古い/空なら生成（呼び出し元をブロックしない）。 */
async function runGenerationIfStale(): Promise<void> {
  try {
    const res = await pool.query(
      `SELECT generated_at FROM trend_keywords ORDER BY generated_at DESC LIMIT 1`
    );
    const stale =
      res.rows.length === 0 ||
      Date.now() - new Date((res.rows[0] as { generated_at: Date }).generated_at).getTime() > STALE_MS;
    if (stale) await generateTrendKeywords();
  } catch (e) {
    console.error("trend sweeper:", (e as any)?.message);
  }
}

/** モジュールレベル冪等スイーパー: 初回起動時に生成(古い場合)、以降6時間ごと。 */
export function ensureTrendSweeper(): void {
  if (trendSweeperStarted) return;
  trendSweeperStarted = true;
  setImmediate(() => {
    runGenerationIfStale().catch(() => {});
  });
  setInterval(() => {
    runGenerationIfStale().catch(() => {});
  }, TREND_INTERVAL_MS);
}
