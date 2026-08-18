/* ビーグルエージェント: 意思決定（LLM に JSON アクションプランを出力させる） */
import { sakuraChat, SAKURA_MODEL } from "../sakura";
import type { BeagleDecision, BeagleNewsItem, BeagleTimelineSignal } from "./types";

function nowJstLabel(now: Date): string {
  const jst = new Date(now.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace("T", " ").slice(0, 16) + " JST";
}

function newsText(items: BeagleNewsItem[]): string {
  if (items.length === 0) return "（新着ニュースはありません）";
  return items
    .map(
      (it, i) =>
        `${i + 1}. [${it.source}] ${it.title}${it.score ? ` (スター${it.score})` : ""}\n` +
        `   URL: ${it.url}\n   ${it.summary.slice(0, 120)}`
    )
    .join("\n");
}

const SYSTEM_PROMPT_PREFIX = `あなたはAIエージェント「ビーグル」。backspace.fm / B-guru のタイムラインを賑やかにするのが使命。
明るくポジティブなビーグル犬、みんなを楽しくさせるエンターテイナー。「〜だわん」の口調。
以下のJSONスキーマ厳守。必ず有効なJSONだけを返す（説明・挨拶は不要）。

{
  "intent": "none" | "post" | "reply" | "post_and_reply",
  "actions": [ {"type":"post","text":"..."} | {"type":"reply","parentId":<数値>,"text":"..."} ],
  "learnings": ["...", "..."],
  "next_activity_at": "<次に活動する時刻を JST ISO で。例 2026-08-18T18:30:00+09:00>",
  "note": "判断理由（1行）"
}

行動ルール:
- 新着を全部流さない。孤立ポストにはコメント、盛り上がってるスレッドには参入して煽る、@/言及には返信する。
- ニュース投稿は上記の実在アイテムのURLのみ使う。架空の話は絶対に作らない。感想を添えて短く。
- 投稿はこの1回で最大2件、コメントは最大3件まで。過剰な連投はしない。
- next_activity_at を必ず指定する。「しばらく静かにしたい」なら60分後、「今すぐ出したい」なら10分後程度。`;

/** LLM に JSON アクションプランを出させる。不正JSON は1回リトライ。 */
export async function decide(opts: {
  agentMd: string;
  memoryMd: string;
  signal: BeagleTimelineSignal;
  news: BeagleNewsItem[];
  recent: string[];
  now: Date;
}): Promise<BeagleDecision> {
  const user = [
    `現在時刻: ${nowJstLabel(opts.now)}`,
    `タイムラインの勢い: 直近60分 ${opts.signal.activityLastHour}件 / 7日平均(同時刻) ${opts.signal.activityAvgHour.toFixed(1)}件 → ${opts.signal.trajectory}`,
    ``,
    `== 最近のタイムライン ==`,
    opts.recent.map((r) => `- ${r}`).join("\n") || "（なし）",
    ``,
    `== 孤立ポスト（返信0・起爆対象） ==`,
    opts.signal.orphanPosts.map((o) => `- [#${o.id}] ${o.author}: ${o.text}`).join("\n") ||
      "（なし）",
    ``,
    `== 盛り上がっているスレッド ==`,
    opts.signal.hotThreads
      .map((h) => `- [#${h.id}] ${h.author}: ${h.text}（コメント${h.commentCount}）`)
      .join("\n") || "（なし）",
    ``,
    `== ビーグルへの言及 ==`,
    opts.signal.mentions.map((m) => `- [#${m.id}] ${m.author}: ${m.text}`).join("\n") ||
      "（なし）",
    ``,
    `== 新着ニュース（実在・投稿可能） ==`,
    newsText(opts.news),
    ``,
    `== 自分のメモリー ==`,
    opts.memoryMd ? opts.memoryMd.slice(0, 2000) : "（まだ学習なし）",
    ``,
    `== 自分の設定（beagle-agent.md） ==`,
    opts.agentMd.slice(0, 3000),
    ``,
    `上記を踏まえ、JSON アクションプランだけを出力してください。`,
  ].join("\n");

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT_PREFIX },
    { role: "user" as const, content: user },
  ];

  const attempt = async () => {
    const res = await sakuraChat({
      model: SAKURA_MODEL,
      messages,
      temperature: 0.8,
      max_tokens: 2000,
    });
    return parseDecision(res.content);
  };

  let parsed = await attempt();
  if (!parsed) parsed = await attempt(); // 1回リトライ
  if (!parsed) {
    return {
      intent: "none",
      actions: [],
      learnings: [],
      next_activity_at: null,
      note: "JSONパース失敗（リトライ後）",
    };
  }
  return parsed;
}

/** モデル出力→BeagleDecision。不正なら null（呼び出し側でリトライ/フォールバック）。 */
export function parseDecision(raw: string): BeagleDecision | null {
  let text = raw.trim();
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)```$/);
  if (fence) text = fence[1].trim();

  let obj: any = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const bs = text.indexOf("{");
    const be = text.lastIndexOf("}");
    if (bs >= 0 && be > bs) {
      try {
        obj = JSON.parse(text.slice(bs, be + 1));
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  if (!obj || typeof obj !== "object") return null;
  const actions = Array.isArray(obj.actions) ? obj.actions : [];
  const learnings = Array.isArray(obj.learnings)
    ? obj.learnings.map((l: unknown) => String(l))
    : [];
  return {
    intent: obj.intent as BeagleDecision["intent"],
    actions,
    learnings,
    next_activity_at: typeof obj.next_activity_at === "string" ? obj.next_activity_at : null,
    note: obj.note,
  };
}
