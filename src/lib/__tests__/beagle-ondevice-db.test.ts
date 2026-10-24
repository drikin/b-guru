/**
 * 🐶 端末内 AI のビーグルの DB を通した確認（lib/beagle-ondevice.ts）。
 * 使い捨ての PostgreSQL が要る: BEAGLE_AI_TEST_DATABASE_URL があるときだけ動く。
 *   例: BEAGLE_AI_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run beagle-ondevice-db
 *
 *  - 自分の @ビーグル の質問に 1 回だけ答えられる（発言者名に誰の端末か、未読に数えない、記録が残る）
 *  - 他人の質問・@ビーグル でない・古い質問・フラグなしは断る、2 回目は 409
 *  - 答えのついた質問は編集できない、出した本人だけが消せる
 *  - 1 人 30 回の上限
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const URL_ = process.env.BEAGLE_AI_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  chat: typeof import("../chat");
  bg: typeof import("../beagle-ondevice");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `bg-a-${stamp}@test.local`;
const B = `bg-b-${stamp}@test.local`;

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

d("🐶 端末内 AI のビーグル（DB）", () => {
  beforeAll(async () => {
    m = { db: await import("../db"), chat: await import("../chat"), bg: await import("../beagle-ondevice"), user: await import("../user") };
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
    process.env.BEAGLE_ONDEVICE_ENABLED = "1";
    await sql(`DELETE FROM beagle_ai_log; DELETE FROM chat_messages`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM beagle_ai_log; DELETE FROM chat_messages`);
    await m.db.pool.end();
  });

  const ask = (email: string, body: string) => m.chat.createChatMessage(email, null, body);

  it("自分の質問に 1 回だけ。名前に誰の端末か、未読に数えない、記録が残る", async () => {
    const q = await ask(A, "@ビーグル 今日のおすすめは？");
    const r = await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "カメラの話がおすすめだわん https://x.example", app: "iOS 0.2.49" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.message).toMatchObject({ kind: "beagle_ai", replyToId: q.id, authorName: "ビーグル（ねこさんの端末）", body: "カメラの話がおすすめだわん" });
    // 一覧でも名前は書き換わらない
    const list = await m.chat.listChatMessages({ viewerEmail: B });
    expect(list.find((x) => x.id === r.message.id)?.authorName).toBe("ビーグル（ねこさんの端末）");
    // B の未読: A の質問の 1 件だけ（ビーグルの答えは数えない）
    expect(await m.chat.getUnreadCount(B)).toBe(1);
    const log = await sql(`SELECT question_body, answer, ai_by_email, app FROM beagle_ai_log`);
    expect(log.rows).toEqual([{ question_body: "@ビーグル 今日のおすすめは？", answer: "カメラの話がおすすめだわん", ai_by_email: A, app: "iOS 0.2.49" }]);
    const again = await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "もう一回" });
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it("他人の質問・@ビーグル でない・10 分より前・フラグなしは断る", async () => {
    const q = await ask(A, "@ビーグル こんにちは");
    expect(await m.bg.postBeagleAiReply({ email: B, questionId: q.id, body: "x" })).toMatchObject({ ok: false, status: 403 });
    const plain = await ask(A, "こんにちは");
    expect(await m.bg.postBeagleAiReply({ email: A, questionId: plain.id, body: "x" })).toMatchObject({ ok: false, status: 400 });
    const old = await ask(A, "@ビーグル 昔の質問");
    await sql(`UPDATE chat_messages SET created_at = now() - interval '11 minutes' WHERE id = $1`, [old.id]);
    expect(await m.bg.postBeagleAiReply({ email: A, questionId: old.id, body: "x" })).toMatchObject({ ok: false, status: 404 });
    process.env.BEAGLE_ONDEVICE_ENABLED = B; // A には出していない
    expect(await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "x" })).toMatchObject({ ok: false, status: 404 });
  });

  it("答えのついた質問は編集できない、出した本人だけが消せる", async () => {
    const q = await ask(A, "@ビーグル 好きな食べ物は？");
    const r = await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "ジャーキーだわん" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(await m.chat.editChatMessage(q.id, A, "@ビーグル 嫌いな食べ物は？")).toBeNull();
    expect(await m.bg.deleteBeagleAiReply(B, r.message.id)).toBe(false);
    expect(await m.bg.deleteBeagleAiReply(A, r.message.id)).toBe(true);
    // ふつうの質問は今までどおり編集できる
    const p = await ask(A, "@ビーグル まだ答えのない質問");
    expect(await m.chat.editChatMessage(p.id, A, "@ビーグル 直した")).not.toBeNull();
  });

  it("1 人 24 時間 30 回まで", async () => {
    for (let i = 0; i < 30; i++) {
      await sql(`INSERT INTO beagle_ai_log (question_id, question_body, answer, ai_by_email) VALUES (0, 'q', 'a', $1)`, [A]);
    }
    const q = await ask(A, "@ビーグル 31 回目");
    expect(await m.bg.postBeagleAiReply({ email: A, questionId: q.id, body: "x" })).toMatchObject({ ok: false, status: 429 });
    const qb = await ask(B, "@ビーグル B は大丈夫");
    expect((await m.bg.postBeagleAiReply({ email: B, questionId: qb.id, body: "答えるわん" })).ok).toBe(true);
  });
});
