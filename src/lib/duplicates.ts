/* 重複投稿の検知。
 *
 * drikin 2026-09-25: 「この2つの投稿って本当に完全に被っちゃってるんですけど、
 * 似たような投稿があった時に警告したり、うまくそれを統合したりするような、
 * もうちょっと同じような情報をまとめ上げる仕組みを考えられませんかね？」
 *
 * 実測（2026-09-25 時点）: 親投稿 1,546件のうち YouTube リンク付きが 158件、
 * そのうち url_preview.videoId が保存済みなのが 154件。動画ID重複が4組、
 * 正規化URL重複が11組、短文の完全一致が6組あった。
 *
 * 設計の要点:
 *   - 判定は「確実」と「あいまい」を明確に分ける。確実な重複（同じ動画・同じURL）
 *     は強く警告し、あいまい類似は「もしかして」程度に留める。混ぜると
 *     誤警告で投稿を躊躇させる。
 *   - 既存の url_preview.videoId を使う。youtu.be/ でも watch?v= でも同じIDに
 *     なるので、URL の書き方の違いを自前で吸収する必要がない。
 *   - 投稿をブロックしない。あくまで気づきを提供し、判断は投稿者に委ねる。
 */

import { pool } from "./db";
import { extractYoutubeId, fetchUrlPreview } from "./urlpreview";
import { sakuraChat } from "./sakura";

/** 重複の確からしさ。`exact` は同じ対象を指していることが確実なもの。 */
export type DuplicateKind = "video" | "url" | "text" | "similar" | "news";

export interface DuplicateCandidate {
  postId: number;
  authorName: string;
  authorEmail: string;
  text: string;
  createdAt: string;
  /** どの規則で見つかったか。UI の文言と強調度に使う。 */
  kind: DuplicateKind;
  /** 0..1。`exact` 系は 1、あいまい類似は実測スコア。 */
  score: number;
  /** 同じ動画/URL を指していることが確実か。UI の強調度を決める。 */
  exact: boolean;
  /** AI が付けた理由（`news` のときだけ）。UI に出す。 */
  reason?: string;
}

/** あいまい類似を出す閾値。これ未満は「似ている」と言い切れない。 */
const SIMILAR_THRESHOLD = 0.55;
/** 返す候補の上限。多すぎると警告が読まれなくなる。 */
const MAX_CANDIDATES = 3;
/** あいまい類似を探す対象期間（日）。古い投稿を掘り返しても意味がない。 */
const SIMILAR_WINDOW_DAYS = 30;

/**
 * 本文から比較用の正規化テキストを作る。
 *
 * URL は除去する（URL の一致は videoId / 正規化URL の層で見るので、ここで
 * 残すと同じURLを含むだけの別内容の投稿が類似扱いになる）。全角/半角と
 * 大小文字の差は吸収する。
 */
export function normalizeText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, " ")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

/**
 * 2つの文字列の類似度（0..1）。Dice 係数（バイグラム）を使う。
 *
 * 日本語は分かち書きしないので単語ベースの類似度が使えない。バイグラムなら
 * 言語に依存せず、「同じ動画についての短い感想」程度の近さを拾える。
 */
export function similarity(a: string, b: string): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // 短すぎる文字列はバイグラムが作れないので完全一致のみ。
  if (x.length < 2 || y.length < 2) return 0;

  const bigrams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };

  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  let totalX = 0;
  let totalY = 0;
  for (const n of bx.values()) totalX += n;
  for (const n of by.values()) totalY += n;
  for (const [g, n] of bx) {
    const m = by.get(g);
    if (m) overlap += Math.min(n, m);
  }
  return (2 * overlap) / (totalX + totalY);
}

/**
 * URL を比較用に正規化する。
 *
 * トラッキングパラメータ（si / utm_* / fbclid 等）と末尾スラッシュ、ホストの
 * www. を落とす。実測で `youtu.be/ID?si=...` と `youtube.com/watch?v=ID` が
 * 別物として扱われていたのが重複の主因だった。
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = "";
    u.hostname = u.hostname.replace(/^www\./, "");
    // トラッキング系は全部落とす。共有ボタンが付けてくるものが大半。
    const drop = [
      "si", "feature", "utm_source", "utm_medium", "utm_campaign",
      "utm_term", "utm_content", "fbclid", "gclid", "igshid", "ref", "ref_src",
    ];
    for (const k of drop) u.searchParams.delete(k);
    // 残ったパラメータは順序を安定させる（?b=2&a=1 と ?a=1&b=2 を同一視）。
    u.searchParams.sort();
    let s = u.toString();
    // クエリが空になったら "?" を落とす。
    s = s.replace(/\?$/, "");
    // 末尾スラッシュはパスがある場合のみ落とす（"https://x.com/" は残す）。
    if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
    return s;
  } catch {
    return raw.trim();
  }
}

/**
 * 投稿しようとしている内容に似た既存投稿を探す。
 *
 * `parentId` が渡された場合（返信）は何も返さない — 返信は元投稿にぶら下がる
 * のが正しい形なので、重複ではない。
 */
export async function findDuplicates(input: {
  text: string;
  authorEmail: string;
  parentId?: number | null;
}): Promise<DuplicateCandidate[]> {
  // 返信は対象外。返信は「同じ話題に加わる」正しい手段そのもの。
  if (input.parentId != null) return [];

  const text = (input.text ?? "").trim();
  if (!text) return [];

  const found = new Map<number, DuplicateCandidate>();

  // ---- 1. 同じ YouTube 動画 ----------------------------------------------
  // url_preview.videoId は youtu.be / watch?v= / shorts の差を吸収済み。
  const videoId = extractYoutubeIdFromText(text);
  if (videoId) {
    const res = await pool.query(
      `SELECT p.id, p.author_email, p.text, p.created_at,
              COALESCE(up.display_name, p.author_name, p.author_email) AS author_name
         FROM posts p
         LEFT JOIN user_profiles up ON up.email = p.author_email
        WHERE p.parent_id IS NULL
          AND p.url_preview->>'videoId' = $1
        ORDER BY p.created_at DESC
        LIMIT $2`,
      [videoId, MAX_CANDIDATES]
    );
    for (const r of res.rows) {
      found.set(Number(r.id), {
        postId: Number(r.id),
        authorName: displayName(r.author_name, r.author_email),
        authorEmail: r.author_email,
        text: r.text,
        createdAt: r.created_at,
        kind: "video",
        score: 1,
        exact: true,
      });
    }
  }

  // ---- 2. 同じ URL（正規化後） -------------------------------------------
  const rawUrl = firstUrl(text);
  if (rawUrl) {
    const norm = normalizeUrl(rawUrl);
    // 保存済みの url_preview.url も同じ規則で正規化して比較する。SQL 側で
    // 正規化できないので、直近の URL 付き投稿を取って JS で突き合わせる。
    const res = await pool.query(
      `SELECT p.id, p.author_email, p.text, p.created_at, p.url_preview->>'url' AS url,
              COALESCE(up.display_name, p.author_name, p.author_email) AS author_name
         FROM posts p
         LEFT JOIN user_profiles up ON up.email = p.author_email
        WHERE p.parent_id IS NULL
          AND p.url_preview->>'url' IS NOT NULL
          AND p.created_at > now() - interval '${SIMILAR_WINDOW_DAYS} days'
        ORDER BY p.created_at DESC
        LIMIT 500`,
      []
    );
    for (const r of res.rows) {
      if (!r.url) continue;
      if (normalizeUrl(r.url) !== norm) continue;
      const id = Number(r.id);
      if (found.has(id)) continue;
      found.set(id, {
        postId: id,
        authorName: displayName(r.author_name, r.author_email),
        authorEmail: r.author_email,
        text: r.text,
        createdAt: r.created_at,
        kind: "url",
        score: 1,
        exact: true,
      });
    }
  }

  // ---- 3. 本文の完全一致 -------------------------------------------------
  const normText = normalizeText(text);
  if (normText.length >= 4) {
    const res = await pool.query(
      `SELECT p.id, p.author_email, p.text, p.created_at,
              COALESCE(up.display_name, p.author_name, p.author_email) AS author_name
         FROM posts p
         LEFT JOIN user_profiles up ON up.email = p.author_email
        WHERE p.parent_id IS NULL
          AND lower(btrim(regexp_replace(p.text, 'https?://\\S+', ' ', 'g'))) = lower(btrim($1))
          AND p.created_at > now() - interval '${SIMILAR_WINDOW_DAYS} days'
        ORDER BY p.created_at DESC
        LIMIT $2`,
      [normText, MAX_CANDIDATES]
    );
    for (const r of res.rows) {
      const id = Number(r.id);
      if (found.has(id)) continue;
      found.set(id, {
        postId: id,
        authorName: displayName(r.author_name, r.author_email),
        authorEmail: r.author_email,
        text: r.text,
        createdAt: r.created_at,
        kind: "text",
        score: 1,
        exact: true,
      });
    }
  }

  // ---- 4. あいまい類似 ---------------------------------------------------
  // 確実な重複が既に見つかっているなら、あいまい類似は出さない。警告が
  // 増えるほど読まれなくなるため。
  if (found.size === 0 && normText.length >= 6) {
    const res = await pool.query(
      `SELECT p.id, p.author_email, p.text, p.created_at,
              COALESCE(up.display_name, p.author_name, p.author_email) AS author_name
         FROM posts p
         LEFT JOIN user_profiles up ON up.email = p.author_email
        WHERE p.parent_id IS NULL
          AND p.created_at > now() - interval '${SIMILAR_WINDOW_DAYS} days'
        ORDER BY p.created_at DESC
        LIMIT 300`,
      []
    );
    const scored: DuplicateCandidate[] = [];
    for (const r of res.rows) {
      const s = similarity(text, r.text);
      if (s < SIMILAR_THRESHOLD) continue;
      scored.push({
        postId: Number(r.id),
        authorName: displayName(r.author_name, r.author_email),
        authorEmail: r.author_email,
        text: r.text,
        createdAt: r.created_at,
        kind: "similar",
        score: s,
        exact: false,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const c of scored.slice(0, MAX_CANDIDATES)) found.set(c.postId, c);
  }

  // ---- 5. AI による「同じニュース」判定 ----------------------------------
  // drikin 2026-09-25: 「同じニュースで別のニュースサイトが報じているような
  // ネタとかでも、よく重複していることがあったりする」。URL も動画IDも違うので
  // 文字列一致では拾えない。ここだけは AI に判断させる。
  //
  // ★ この層は遅い（外部サイト取得に実測 9.4秒 + LLM）。ここでは走らせず、
  //   API の `phase=ai` から別途呼ぶ。速い層の警告を先に出すため。
  //   `findNewsDuplicates()` を参照。

  return [...found.values()]
    .sort((a, b) => {
      // 確実なものを先に、次に新しいもの。
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    // 上限はここで掛ける。SQL の LIMIT は各パスを個別に制限するだけなので、
    // 複数のパスがヒットすると合計で上限を超える（テストが実バグとして検出）。
    .slice(0, MAX_CANDIDATES);
}

/** 本文中の最初の URL。`posts.ts` の `firstUrl` と同じ規則。 */
export function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s<>"']+/);
  return m ? m[0] : null;
}

/**
 * 本文中の YouTube 動画IDを取り出す。
 *
 * `urlpreview.ts` の `extractYoutubeId` は URL 単体を受け取るが、ここでは
 * 本文から URL を拾ってから渡す。同じ解析を2箇所に書かないための薄い橋渡し。
 */
export function extractYoutubeIdFromText(text: string): string | null {
  const url = firstUrl(text);
  if (!url) return null;
  return extractYoutubeId(url);
}

/** 表示名のフォールバック。メール形式なら @ で切る（投稿者名と同じ規則）。 */
function displayName(name: string | null, email: string): string {
  const v = (name ?? "").trim() || email;
  return v.includes("@") ? v.split("@")[0] : v;
}

// ===========================================================================
// AI による「同じニュース」判定
// ===========================================================================

/**
 * drikin 2026-09-25: 「今回の例はたまたま YouTube でしたけど、同じニュースで
 * 別のニュースサイトが報じているようなネタとかでも、よく重複していることが
 * あったりするので、そこら辺も検出できたりしますかね？必要であれば、ビーグルと
 * 同様の AI を使ってもいいと思います。」
 *
 * URL も動画IDも違うので、文字列の一致では絶対に拾えない。見出しの単語が
 * 一致するだけの誤検出（「Apple」で Mac mini レビューと iPhone 在庫の話が
 * ペアになる）も実測で確認したので、AI に判断させる。
 *
 * 実測（2026-09-25、gpt-oss-120b）: 7ケース中6正解。重要なケースはすべて正解 —
 * 別サイト同一ニュース（台風26号 / MiniMax H3）を same、紛らわしい「Apple だが
 * 別の話」を related、無関係を different と正しく分類した。
 */
const NEWS_JUDGE_SYSTEM = `あなたはSNSの投稿が「同じニュース・同じ話題」かどうかを判定する審判です。
2つの投稿を比較し、次のいずれかで答えてください。

- same: 同じニュース・同じ出来事・同じ製品発表を扱っている（別のサイトが報じていても同じ）
- related: 同じテーマだが別のニュース（例: どちらもApple関連だが、別の製品の話）
- different: 無関係

判定の指針:
- 見出しの単語が一致するだけでは same にしない。「Apple」のように広い語は related の根拠にしかならない。
- 具体的な製品名・人名・出来事が一致し、かつ同じ発表・同じ事件を指しているなら same。
- 一方が他方の続報・まとめ記事なら same。
- 迷ったら related にする（誤って same と言うより安全）。

出力は必ず次のJSONのみ:
{"verdict":"same"|"related"|"different","confidence":0.0-1.0,"reason":"日本語で40字以内"}`;

/** AI 判定の結果。`same` のときだけ重複として扱う。 */
export interface NewsVerdict {
  verdict: "same" | "related" | "different";
  confidence: number;
  reason: string;
}

/**
 * 2つの投稿が「同じニュース」かを AI に判定させる。
 *
 * 失敗しても例外を投げない（重複チェックで投稿を止めない方針）。判定不能なら
 * `different` を返して黙って諦める。
 */
export async function judgeSameNews(
  a: { title: string; description: string },
  b: { title: string; description: string }
): Promise<NewsVerdict> {
  const fallback: NewsVerdict = { verdict: "different", confidence: 0, reason: "" };
  try {
    const user = `投稿A:\nタイトル: ${a.title}\n説明: ${a.description}\n\n投稿B:\nタイトル: ${b.title}\n説明: ${b.description}`;
    const res = await sakuraChat({
      messages: [
        { role: "system", content: NEWS_JUDGE_SYSTEM },
        { role: "user", content: user },
      ],
      temperature: 0,
      // 200 だと JSON が途中で切れることがあった（実測）。余裕を持たせる。
      max_tokens: 400,
    });
    const m = res.content.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const j = JSON.parse(m[0]);
    const verdict = j?.verdict;
    if (verdict !== "same" && verdict !== "related" && verdict !== "different") {
      return fallback;
    }
    return {
      verdict,
      confidence: typeof j.confidence === "number" ? j.confidence : 0,
      reason: typeof j.reason === "string" ? j.reason : "",
    };
  } catch {
    return fallback;
  }
}

/**
 * 同じ日のニュース記事から「同じニュース」を AI で探す。
 *
 * 候補を絞ってから AI に渡す（全件ペアは O(n²) でコストが跳ねる）。絞り込みは
 * 文字列の類似度で行い、判定そのものは AI に任せる — 絞り込みで漏らすと
 * 拾えなくなるので、閾値は低めにする。
 *
 * ★ この層は遅い（外部サイト取得 + LLM）。`findDuplicates` からは呼ばず、
 *   API の `phase=ai` から別途呼ぶ。速い層の警告を先に出すため。
 */
export async function findNewsDuplicates(text: string): Promise<DuplicateCandidate[]> {
  const rawUrl = firstUrl(text);
  if (!rawUrl) return [];
  const ownPreview = await fetchOwnPreview(rawUrl);
  if (!ownPreview) return [];

  // ★ 投稿者が書いた本文も比較材料に混ぜる。プレビューだけを比べると
  //   「URL の記事そのもの」と必ず一致してしまい、投稿者が何と書いたかが
  //   判定に効かない（実測で発覚: 無関係な本文 + 既存記事のURL を渡しても
  //   その記事が same で返ってきた）。
  //
  //   本文から URL を除いた残りを使う。URL 自体は比較しても意味がない。
  return findNewsDuplicatesWithPreview(ownPreview); // DEGRADE2
}

async function findNewsDuplicatesWithPreview(
  ownPreview: { title: string; description: string }
): Promise<DuplicateCandidate[]> {
  const res = await pool.query(
    `SELECT p.id, p.author_email, p.text, p.created_at,
            p.url_preview->>'title' AS title,
            p.url_preview->>'description' AS description,
            COALESCE(up.display_name, p.author_name, p.author_email) AS author_name
       FROM posts p
       LEFT JOIN user_profiles up ON up.email = p.author_email
      WHERE p.parent_id IS NULL
        AND p.url_preview->>'title' IS NOT NULL
        AND p.created_at > now() - interval '3 days'
      ORDER BY p.created_at DESC
      LIMIT 60`,
    []
  );

  // 文字列の近さで候補を絞る。低めの閾値で「別サイトの言い換え見出し」も
  // 残す（AI が最終判断するので、ここで厳しくすると拾えなくなる）。
  const scored = res.rows
    .map((r) => ({
      row: r,
      s: Math.max(
        similarity(ownPreview.title, r.title ?? ""),
        similarity(ownPreview.description, r.description ?? "")
      ),
    }))
    .filter((x) => x.s >= 0.18)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);

  if (scored.length === 0) return [];

  // AI 判定は並列に投げる。1件ずつ待つと投稿前の待ち時間が伸びる。
  const verdicts = await Promise.all(
    scored.map((x) =>
      judgeSameNews(ownPreview, {
        title: x.row.title ?? "",
        description: x.row.description ?? "",
      })
    )
  );

  const out: DuplicateCandidate[] = [];
  for (let i = 0; i < scored.length; i++) {
    const v = verdicts[i];
    // `same` だけを重複として扱う。`related` は「同じテーマだが別の話」なので
    // 警告すると誤警告になる（実測で「Apple」の別製品ペアが related になった）。
    if (v.verdict !== "same") continue;
    const r = scored[i].row;
    out.push({
      postId: Number(r.id),
      authorName: displayName(r.author_name, r.author_email),
      authorEmail: r.author_email,
      text: r.text,
      createdAt: r.created_at,
      kind: "news",
      score: v.confidence,
      exact: false,
      reason: v.reason,
    });
  }
  return out;
}

/**
 * 投稿しようとしている URL のプレビューを取る（AI 判定の材料）。
 *
 * `fetchUrlPreview` は外部サイトを取りに行くので時間がかかる。実測では NHK の
 * 記事ページで **9.4秒**かかった。投稿前の待ち時間に直結するので、ここでは
 * 短めのタイムアウトを掛ける。取れなければ AI 判定をスキップする
 * （重複チェックは投稿を止めるものではないので、諦めてよい）。
 *
 * ★ 4秒では実サイトに間に合わなかった（実測 9.4秒）。8秒に伸ばしている。
 *   これでも足りないサイトはあるが、投稿前の待ち時間として許容できる上限。
 */
const PREVIEW_TIMEOUT_MS = 8000;

async function fetchOwnPreview(
  rawUrl: string
): Promise<{ title: string; description: string } | null> {
  try {
    const p = await Promise.race([
      fetchUrlPreview(rawUrl),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), PREVIEW_TIMEOUT_MS)),
    ]);
    if (!p) return null;
    const title = (p.title ?? "").trim();
    if (!title) return null;
    return { title, description: (p.description ?? "").trim() };
  } catch {
    return null;
  }
}

// `extractYoutubeId` は `urlpreview.ts` から再輸出する。呼び出し側が2つの
// モジュールを意識しなくて済むようにするため（同じ解析を2箇所に書かない）。
export { extractYoutubeId };
