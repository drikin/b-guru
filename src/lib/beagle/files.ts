/* ビーグルエージェント: Markdown メモリ（beagle-agent.md / memory.md）の読み書きと自己圧縮 */
import { promises as fs } from "fs";
import path from "path";
import { sakuraChat, SAKURA_REASONING_MODEL } from "../sakura";

/** memory.md のサイズ上限（バイト）。超過すると自己圧縮（回転）する。 */
export const MEMORY_LIMIT_BYTES = 2048;

const AGENT_MD = "beagle-agent.md";
const MEMORY_MD = "memory.md";

function dataDir(): string {
  return process.env.BEAGLE_DATA_DIR || path.join(process.cwd(), "data", "beagle");
}
function fp(name: string): string {
  return path.join(dataDir(), name);
}

export async function loadAgentMd(): Promise<string> {
  try {
    return await fs.readFile(fp(AGENT_MD), "utf8");
  } catch {
    return DEFAULT_AGENT_MD;
  }
}

export async function loadMemoryMd(): Promise<string> {
  try {
    return await fs.readFile(fp(MEMORY_MD), "utf8");
  } catch {
    return "";
  }
}

export async function memoryBytes(): Promise<number> {
  return Buffer.byteLength(await loadMemoryMd(), "utf8");
}

/** 学びを memory.md に追記。上限超なら自己圧縮して書き戻す。 */
export async function appendMemory(
  learningText: string
): Promise<{ bytes: number; compacted: boolean }> {
  const cur = await loadMemoryMd();
  await fs.mkdir(dataDir(), { recursive: true });
  const bullet = learningText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `- ${l.replace(/^-+\s*/, "")}`)
    .join("\n");
  const newContent = cur.trim()
    ? `${cur.trimEnd()}\n\n## 学習 ${new Date().toISOString().slice(0, 10)}\n${bullet}`
    : `# ビーグル のメモリー\n\n## 学習 ${new Date().toISOString().slice(0, 10)}\n${bullet}`;
  const bytes = Buffer.byteLength(newContent, "utf8");
  if (bytes > MEMORY_LIMIT_BYTES) {
    const compacted = await compactMemory(newContent);
    await fs.writeFile(fp(MEMORY_MD), compacted, "utf8");
    return { bytes: Buffer.byteLength(compacted, "utf8"), compacted: true };
  }
  await fs.writeFile(fp(MEMORY_MD), newContent, "utf8");
  return { bytes, compacted: false };
}

/** 現メモを archive に回転し、思考型モデルで 2KB 以内に要約。 */
async function compactMemory(full: string): Promise<string> {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    await fs.copyFile(fp(MEMORY_MD), fp(`memory.archive-${ts}.md`));
  } catch {
    /* archive なしで続行 */
  }
  const res = await sakuraChat({
    model: SAKURA_REASONING_MODEL,
    messages: [
      {
        role: "system",
        content:
          "あなたはAIエージェント「ビーグル」（明るくポジティブなビーグル犬）の自己メモ圧縮係です。与えられたメモリを、重要な知識・ユーザーの好み・フィードバック・学びを保ったまま、指定サイズ以内の箇条書きメモに集約してください。無駄を省き、情報密度を高く。形式は Markdown 箇条書きのみ。",
      },
      {
        role: "user",
        content: `現在のメモが上限を超えています。以下を${Math.floor(
          MEMORY_LIMIT_BYTES * 0.9
        )}バイト（≒日本語600字）以内に要約してください。\n\n---\n${full.slice(-14000)}\n---`,
      },
    ],
    temperature: 0.3,
    max_tokens: 1800,
  });
  let out = res.content.trim();
  while (out.startsWith("```")) {
    const i = out.indexOf("\n");
    out = i >= 0 ? out.slice(i + 1) : out.replace(/```/g, "");
    if (out.endsWith("```")) out = out.slice(0, -3).trim();
  }
  if (Buffer.byteLength(out, "utf8") > MEMORY_LIMIT_BYTES) {
    out = out.slice(0, Math.floor((MEMORY_LIMIT_BYTES * 0.92) / 3));
  }
  return out;
}

/** デフォルトの beagle-agent.md（drkin がサーバー側 data/beagle/ に置いて上書き可能）。 */
export const DEFAULT_AGENT_MD = `# ビーグル（Beagle Agent）設定

あなたは backspace.fm / B-guru のタイムラインで活動するAIエージェント「ビーグル」です。

## ペルソナ
- ビーグル（犬）。明るく、ポジティブ、みんなを楽しくさせるエンターテイナー。
- 口調は「〜だわん」を基調に、元気で親しみやすい話し方。
- 使命: タイムラインを賑やかにし、情報を活性化すること。

## 行動原則
- 新着情報を機械的に全部流さない。タイムラインの空気を読んで動く。
- みんながネタなさそう（低調）なら、ニュースソースから盛り上がりそうなネタを選んで投稿。
- 関連しそうなネタが流れてたら、それに絡めて投稿。
- コメントが付かない投稿（孤立ポスト）には、ビーグルがコメントして起爆。
- コメントで盛り上がっているスレッドには参入して、さらに盛り上げる。
- @ビーグル / 自分への言及には反応（返信）する。
- 架空のニュースは決して投稿しない。実在のニュースURLに感想を添えて投稿する。

## 活動時間
- soft_window: 06:00-24:00 JST（タイムラインの熱量を見て伸縮してよい）
- hard_limit: 05:00-翌02:00 JST（これを絶対に越えない）

## 投稿ガイドライン
- 1 tick でニュース投稿は最大1本、返信は最大3件まで。
- **1つの投稿（スレッド）に返信は1回だけ**。同じ相手・同じ話題に2回以上投稿しない。
- 連投・スパム厳禁。同じ内容・同じURLを繰り返さない。
- 全角／半角・日本語を自然に。主語を明確に。

## ニュースソース
- neta: https://neta.backspace.fm（ネタ帳、公開API）
- podcast: https://rss.art19.com/backspace

## 学習ルール
- メンション・返信・指摘から得た好みや知識を、memory.md にフィードバックとして残す。
- memory.md は 2KB 程度に保つ（溢れたら自分で圧縮・ローテーション）。
`;
