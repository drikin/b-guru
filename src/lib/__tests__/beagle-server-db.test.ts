/**
 * 🐶 サーバのビーグル（さくらの AI Engine）の DB を通した確認（lib/beagle-server.ts）。AI Engine は呼ばない（差し替え）。
 * BEAGLE_AI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB）。
 *  - 自分の @ビーグル の質問に公式のビーグルとして 1 回だけ答える、記録に残る（上限は端末内 AI と共通）
 *  - 端末内 AI が先に答えていたら答えない、他人の質問・フラグなしは答えない
 *  - モデルに渡す文に、ビーグルの答え・ほかの @ビーグル の質問を入れない
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const calls: { messages: { role: string; content: string }[] }[] = [];
vi.mock("../sakura", () => ({
  SAKURA_MODEL: "gpt-oss-120b",
  sakuraChat: vi.fn(async (opts: { messages: { role: string; content: string }[] }) => {
    calls.push(opts);
    return { content: "久留米は明日雨だわん https://x.example @誰か", model: "gpt-oss-120b" };
  }),
}));
vi.mock("../beagle-lookup", () => ({ lookupFor: vi.fn(async () => "久留米市 明日: 雨（Open-Meteo）") }));

const URL_ = process.env.BEAGLE_AI_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  chat: typeof import("../chat");
  bg: typeof import("../beagle-ondevice");
  sv: typeof import("../beagle-server");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `bs-a-${stamp}@test.local`;
const B = `bs-b-${stamp}@test.local`;
const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);

d("🐶 サーバのビーグル（DB）", () => {
  beforeAll(async () => {
    m = { db: await import("../db"), chat: await import("../chat"), bg: await import("../beagle-ondevice"), sv: await import("../beagle-server"), user: await import("../user") };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    await m.user.ensureUserId(A);
    await m.user.ensureUserId(B);
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`, [A, B]);
  });

  beforeEach(async () => {
    process.env.BEAGLE_SERVER_ENABLED = "1";
    process.env.BEAGLE_ONDEVICE_ENABLED = "1";
    calls.length = 0;
    await sql(`DELETE FROM beagle_ai_log; DELETE FROM chat_messages; DELETE FROM posts`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM beagle_ai_log; DELETE FROM chat_messages`);
    await m.db.pool.end();
  });

  const say = (email: string, body: string) => m.chat.createChatMessage(email, null, body);

  it("公式のビーグルとして 1 回だけ答え、記録に残る（URL・@ は除く）", async () => {
    await say(B, "久留米って雨多いの？");
    const q = await say(A, "@ビーグル 明日の久留米の天気は？");
    expect(await m.sv.answerBeagleQuestion(q.id, A)).toBe(true);
    const ans = await sql(`SELECT author_name, body, ai_by_email, reply_to_id FROM chat_messages WHERE kind = 'beagle_ai'`);
    expect(ans.rows).toEqual([{ author_name: "ビーグル", body: "久留米は明日雨だわん  ＠誰か", ai_by_email: null, reply_to_id: q.id }]);
    const log = await sql(`SELECT ai_by_email, app FROM beagle_ai_log`);
    expect(log.rows).toEqual([{ ai_by_email: A, app: "server:gpt-oss-120b" }]);
    // 渡した文: 調べた結果・チャットの流れ・質問者の名前と質問
    const user = calls[0].messages.find((x) => x.role === "user")!.content;
    expect(user).toContain("調べた結果:\n久留米市 明日: 雨（Open-Meteo）");
    expect(user).toContain("・みけ: 久留米って雨多いの？");
    expect(user).toContain("ねこさんの質問: 明日の久留米の天気は？");
    expect(await m.sv.answerBeagleQuestion(q.id, A)).toBe(false); // 2 回目は答えない
    expect(calls.length).toBe(1);
  });

  it("端末内 AI が先に答えていたら答えない、他人の質問・フラグなしは答えない", async () => {
    const q = await say(A, "@ビーグル こんばんは");
    expect((await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "こんばんはわん" })).ok).toBe(true);
    expect(await m.sv.answerBeagleQuestion(q.id, A)).toBe(false);
    const q2 = await say(A, "@ビーグル 質問");
    expect(await m.sv.answerBeagleQuestion(q2.id, B)).toBe(false);
    process.env.BEAGLE_SERVER_ENABLED = B;
    expect(await m.sv.answerBeagleQuestion(q2.id, A)).toBe(false);
    expect(calls.length).toBe(0);
  });

  it("ビーグルの答え・ほかの @ビーグル の質問は渡さない", async () => {
    const q1 = await say(A, "@ビーグル さっきの質問");
    await m.bg.postBeagleAiReply({ email: A, questionId: q1.id, body: "18Pro を使っているみたいだわん" });
    await say(B, "ふつうの発言");
    const q2 = await say(A, "@ビーグル 今の話題は？");
    expect(await m.sv.answerBeagleQuestion(q2.id, A)).toBe(true);
    const user = calls[0].messages.find((x) => x.role === "user")!.content;
    expect(user).toContain("・みけ: ふつうの発言");
    expect(user).not.toContain("18Pro");
    expect(user).not.toContain("さっきの質問");
  });
});
