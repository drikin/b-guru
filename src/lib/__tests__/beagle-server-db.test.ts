/**
 * 🐶 サーバのビーグル（さくらの AI Engine）の DB を通した確認（lib/beagle-server.ts）。AI Engine は呼ばない（差し替え）。
 * BEAGLE_AI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB）。
 *  - 自分の @ビーグル の質問に公式のビーグルとして 1 回だけ答える、記録に残る（上限は端末内 AI と共通）
 *  - 端末内 AI が先に答えていたら答えない、他人の質問・フラグなしは答えない
 *  - モデルに渡す文に、ビーグル自身の答え（「ビーグル（あなた）」）と前の質問を時刻つきで入れる（会話を続けるため）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const calls: { messages: { role: string; content: string }[] }[] = [];
const judge = { calls: 0, answer: '{"to_beagle": true}' };
vi.mock("../sakura", () => ({
  SAKURA_MODEL: "gpt-oss-120b",
  sakuraChat: vi.fn(async (opts: { messages: { role: string; content: string }[] }) => {
    if (opts.messages[0].content.includes("to_beagle")) {
      judge.calls++;
      return { content: judge.answer, model: "gpt-oss-120b" };
    }
    calls.push(opts);
    return { content: "久留米は明日雨だわん https://x.example @誰か", model: "gpt-oss-120b" };
  }),
}));
vi.mock("../beagle-lookup", async (orig) => ({
  ...(await orig<typeof import("../beagle-lookup")>()),
  lookupFor: vi.fn(async () => "久留米市 明日: 雨（Open-Meteo）"),
}));

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
    judge.calls = 0;
    judge.answer = '{"to_beagle": true}';
    delete process.env.BEAGLE_IMPLICIT_ENABLED;
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
    // 渡した文: 調べた結果・直前の会話（時刻つき）・質問者の名前と質問
    const user = calls[0].messages.find((x) => x.role === "user")!.content;
    expect(user).toContain("調べた結果:\n久留米市 明日: 雨（Open-Meteo）");
    expect(user).toMatch(/・\d\d:\d\d みけ: 久留米って雨多いの？/);
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

  it("ビーグル自身の答えと前の質問も会話として渡す（続きの質問のため）", async () => {
    const q1 = await say(A, "@ビーグル iPhone 18 Pro って何色がある？");
    await m.bg.postBeagleAiReply({ email: A, questionId: q1.id, body: "コズミックオレンジと銀と紺だわん" });
    await say(B, "オレンジいいよね");
    await sql(`INSERT INTO chat_messages (author_email, body, kind) VALUES ($1, 'みけさんが入室', 'notice')`, [B]);
    const q2 = await say(A, "@ビーグル それの重さは？");
    await say(B, "200g くらいだった気がする");
    expect(await m.sv.answerBeagleQuestion(q2.id, A)).toBe(true);
    const user = calls[0].messages.find((x) => x.role === "user")!.content;
    expect(user).toMatch(/直前の会話[^\n]*\n・\d\d:\d\d ねこ（質問者）: @ビーグル iPhone 18 Pro って何色がある？\n・\d\d:\d\d ビーグル（あなた）: コズミックオレンジと銀と紺だわん\n・\d\d:\d\d みけ: オレンジいいよね$/m);
    expect(user).not.toContain("入室");
    expect(user).toMatch(/質問のあとの発言:\n・\d\d:\d\d みけ: 200g くらいだった気がする/);
    expect(user).toMatch(/今 \d\d:\d\d。ねこさんの質問: それの重さは？$/);
  });

  it("@ なし: ビーグルが答えた相手の続きは、判定してから答える", async () => {
    const q1 = await say(A, "@ビーグル iPhone 18 Pro って何色がある？");
    expect(await m.sv.answerBeagleQuestion(q1.id, A)).toBe(true);
    const f = await say(A, "それの重さは？");
    expect(await m.sv.answerBeagleQuestion(f.id, A, { implicit: true })).toBe(true);
    expect(judge.calls).toBe(1);
    const user = calls[1].messages.find((x) => x.role === "user")!.content;
    expect(user).toContain("ビーグル（あなた）: 久留米は明日雨だわん");
    expect(user).toMatch(/ねこさんの発言（@ なしで話しかけられた）: それの重さは？$/);
    const log = await sql(`SELECT app FROM beagle_ai_log ORDER BY id`);
    expect(log.rows.map((r) => r.app)).toEqual(["server:gpt-oss-120b", "server:gpt-oss-120b:implicit"]);
  });

  it("@ なし: 判定が違うと言えば黙る・ほかの人の発言や時間切れは判定もしない・止められる", async () => {
    const q1 = await say(A, "@ビーグル 質問");
    expect(await m.sv.answerBeagleQuestion(q1.id, A)).toBe(true);
    // 答えた相手ではない人の発言（名前もない）→ 判定もしない
    const b = await say(B, "それいいね");
    expect(await m.sv.answerBeagleQuestion(b.id, B, { implicit: true })).toBe(false);
    expect(judge.calls).toBe(0);
    // 判定が false → 黙る
    judge.answer = '{"to_beagle": false}';
    const a2 = await say(A, "みけさんはどう思う？");
    expect(await m.sv.answerBeagleQuestion(a2.id, A, { implicit: true })).toBe(false);
    expect(judge.calls).toBe(1);
    // 時間切れ（答えから 3 分より後）→ 判定もしない。名前で呼べば判定する
    judge.answer = '{"to_beagle": true}';
    await sql(`UPDATE chat_messages SET created_at = now() - interval '5 minutes' WHERE kind = 'beagle_ai'`);
    const a3 = await say(A, "ところで今日寒いね");
    expect(await m.sv.answerBeagleQuestion(a3.id, A, { implicit: true })).toBe(false);
    expect(judge.calls).toBe(1);
    const a4 = await say(B, "ねえビーグル、今日寒い？");
    expect(await m.sv.answerBeagleQuestion(a4.id, B, { implicit: true })).toBe(true);
    expect(judge.calls).toBe(2);
    // フラグで止める・@ つきの発言は @ の道（implicit では答えない）
    process.env.BEAGLE_IMPLICIT_ENABLED = "0";
    const a5 = await say(B, "ビーグルありがとう");
    expect(await m.sv.answerBeagleQuestion(a5.id, B, { implicit: true })).toBe(false);
    delete process.env.BEAGLE_IMPLICIT_ENABLED;
    const a6 = await say(B, "@ビーグル ありがとう");
    expect(await m.sv.answerBeagleQuestion(a6.id, B, { implicit: true })).toBe(false);
    expect(judge.calls).toBe(2);
  });

  it("@ なし: リマインドの依頼はリマインドの道へ・同じ人のまだ答えていない @ の質問があれば待つ", async () => {
    process.env.BEAGLE_REMINDERS_ENABLED = "1";
    process.env.DM_ENABLED = "1";
    const r = await say(A, "ねえビーグル、3分後にカップ麺を教えて");
    expect(await m.sv.answerBeagleQuestion(r.id, A, { implicit: true })).toBe(true);
    const reply = await sql(`SELECT body FROM chat_messages WHERE reply_to_id = $1`, [r.id]);
    expect(reply.rows[0].body).toMatch(/^⏲ わかったわん！3 分後/);
    expect(calls.length).toBe(0); // ふつうの答え（AI）は作らない
    // まだ答えていない @ の質問（アプリの 10 秒待ち）→ @ なしの続きは答えない
    await say(B, "@ビーグル 質問");
    const b2 = await say(B, "ビーグル、あと値段も");
    expect(await m.sv.answerBeagleQuestion(b2.id, B, { implicit: true })).toBe(false);
    await sql(`DELETE FROM beagle_reminders`);
  });
});
