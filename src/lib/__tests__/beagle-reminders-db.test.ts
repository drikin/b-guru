/**
 * 🐶 ビーグルのリマインドの DB を通した確認（lib/beagle-reminders.ts、docs/beagle-reminders-spec.md）。AI Engine は呼ばない（差し替え）。
 * BEAGLE_AI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB）。
 *  - 短いタイマーは AI なしで受け、ビーグルの返信で確かめを出す。時刻が来たら本人に DM（ビーグルから）を 1 回だけ
 *  - AI で読んだ全員向けの予定の事前のお知らせは、時刻ごとにチャットへ「〇〇さんからのお知らせ」で出る
 *  - 一覧・取り消し（自分のものだけ）・上限、リマインドでない「教えて」はふつうの答えへ、端末内 AI はリマインドに答えられない
 *  - 繰り返しは次の回へ進む、長く遅れた 1 回きりは鳴らさない、会員でなくなった人のものは鳴らさない
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

let aiReply = "{}";
const calls: { messages: { role: string; content: string }[] }[] = [];
vi.mock("../sakura", () => ({
  SAKURA_MODEL: "gpt-oss-120b",
  sakuraChat: vi.fn(async (opts: { messages: { role: string; content: string }[] }) => {
    calls.push(opts);
    return { content: aiReply, model: "gpt-oss-120b" };
  }),
}));
vi.mock("../beagle-lookup", () => ({ lookupFor: vi.fn(async () => null) }));
vi.mock("../push-notify", async (orig) => ({ ...(await orig<typeof import("../push-notify")>()), pushDm: vi.fn(async () => 0), pushChatMessage: vi.fn(async () => 0) }));

const URL_ = process.env.BEAGLE_AI_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  chat: typeof import("../chat");
  bg: typeof import("../beagle-ondevice");
  sv: typeof import("../beagle-server");
  r: typeof import("../beagle-reminders");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `rm-a-${stamp}@test.local`;
const B = `rm-b-${stamp}@test.local`;
const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);
const ask = async (email: string, body: string) => {
  const msg = await m.chat.createChatMessage(email, null, body);
  const ok = await m.sv.answerBeagleQuestion(msg.id, email);
  const reply = await sql(`SELECT body FROM chat_messages WHERE reply_to_id = $1 AND kind = 'beagle_ai'`, [msg.id]);
  return { id: msg.id, ok, reply: reply.rows[0]?.body as string | undefined };
};

d("🐶 ビーグルのリマインド（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      chat: await import("../chat"),
      bg: await import("../beagle-ondevice"),
      sv: await import("../beagle-server"),
      r: await import("../beagle-reminders"),
      user: await import("../user"),
    };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    for (const e of [A, B]) {
      await m.user.ensureUserId(e);
      await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT DO NOTHING`, [`t-${e}`, e]);
    }
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`, [A, B]);
  });

  beforeEach(async () => {
    process.env.BEAGLE_SERVER_ENABLED = "1";
    process.env.BEAGLE_ONDEVICE_ENABLED = "1";
    process.env.BEAGLE_REMINDERS_ENABLED = "1";
    process.env.DM_ENABLED = "1";
    calls.length = 0;
    m.r._resetRemindersForTest();
    await sql(`DELETE FROM beagle_reminders; DELETE FROM beagle_ai_log; DELETE FROM chat_messages; DELETE FROM dm_messages`);
  });

  afterAll(async () => {
    if (!m) return;
    m.r._resetRemindersForTest();
    await sql(`DELETE FROM beagle_reminders; DELETE FROM chat_messages; DELETE FROM dm_messages; DELETE FROM sessions WHERE token LIKE 't-rm-%'`);
    await m.db.pool.end();
  });

  it("短いタイマー: AI なしで受け、時刻が来たら本人にビーグルから DM を 1 回だけ", async () => {
    const a = await ask(A, "@ビーグル 3分後にカップ麺を教えて");
    expect(a.ok).toBe(true);
    expect(calls).toHaveLength(0);
    expect(a.reply).toMatch(/^⏲ わかったわん！3 分後（.+）に、ねこさんにお知らせするわん：カップ麺（番号 \d+。/);
    // 端末内 AI はリマインドに答えられない（枠を使わせない）
    const dev = await m.bg.postBeagleAiReply({ email: A, questionId: a.id, body: "ほかの答え" });
    expect(dev).toMatchObject({ ok: false, status: 409, code: "reminder" });

    const row = (await sql(`SELECT id FROM beagle_reminders WHERE owner_email = $1`, [A])).rows[0];
    await sql(`UPDATE beagle_reminders SET next_at = now() - interval '5 seconds' WHERE id = $1`, [row.id]);
    expect(await m.r.fireDue()).toBe(1);
    expect(await m.r.fireDue()).toBe(0); // 二度は鳴らさない
    const dm = await sql(`SELECT sender_email, recipient_email, body FROM dm_messages`);
    expect(dm.rows).toEqual([{ sender_email: "system@backspace.fm", recipient_email: A, body: "⏲ 時間だわん：カップ麺" }]);
  });

  it("全員向けの予定の事前のお知らせ: AI で読み、時刻ごとにチャットへ頼んだ人の名前つきで", async () => {
    aiReply = JSON.stringify({ action: "create", kind: "event", audience: "everyone", text: "オフ会", at: "2099-01-01T20:00", before_minutes: [60, 1440] });
    // 1 年より先は断る（AI の答えでもサーバで確かめる）
    const far = await ask(A, "@ビーグル 2099/1/1 20時からオフ会。前日と1時間前にみんなに知らせて");
    expect(far.reply).toMatch(/1 年より先|過ぎて/);
    const inAWeek = new Date(Date.now() + 7 * 24 * 3600_000);
    const j = new Date(inAWeek.getTime() + 9 * 3600_000);
    const at = `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, "0")}-${String(j.getUTCDate()).padStart(2, "0")}T20:00`;
    aiReply = JSON.stringify({ action: "create", kind: "event", audience: "everyone", text: "オフ会 https://x.example @みけ", at, before_minutes: [60, 1440] });
    const ev = await ask(A, "@ビーグル 来週の今日 20時からオフ会。前日と1時間前にみんなに知らせて");
    expect(ev.reply).toMatch(/^📅 わかったわん！.+・.+に、みんなにお知らせするわん：オフ会 ＠みけ/);
    const rows = (await sql(`SELECT id, group_id, text FROM beagle_reminders WHERE owner_email = $1 ORDER BY next_at`, [A])).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].group_id).toBe(rows[0].id);
    expect(rows[1].group_id).toBe(rows[0].id);
    // 前日のお知らせの時刻が来た（予定はちょうど 1 日後）
    await sql(`UPDATE beagle_reminders SET next_at = now() - interval '1 minute', event_at = now() - interval '1 minute' + interval '1 day' WHERE group_id = $1`, [rows[0].id]);
    await sql(`UPDATE beagle_reminders SET next_at = now() + interval '1 hour' WHERE id = $1`, [rows[1].id]);
    expect(await m.r.fireDue()).toBe(1);
    const chat = await sql(`SELECT author_name, body, kind, reply_to_id FROM chat_messages WHERE reply_to_id IS NULL AND kind = 'beagle_ai'`);
    expect(chat.rows).toHaveLength(1);
    expect(chat.rows[0].author_name).toBe("ビーグル");
    expect(chat.rows[0].body).toMatch(/^📣 ねこさんからのお知らせだわん：明日予定があるわん（.+）：オフ会 ＠みけ/);

    // 取り消しは自分のものだけ（番号でまとめて）
    expect((await ask(B, `@ビーグル リマインド取り消し ${rows[0].id}`)).reply).toMatch(/見つからなかった/);
    expect((await ask(A, `@ビーグル リマインド取り消し ${rows[0].id}`)).reply).toBe("取り消したわん（1 件）");
    expect((await sql(`SELECT count(*)::int AS n FROM beagle_reminders WHERE active`)).rows[0].n).toBe(0);
  });

  it("一覧・リマインドでない質問はふつうの答え・上限", async () => {
    aiReply = JSON.stringify({ action: "create", kind: "repeat", audience: "me", text: "配信の準備", repeat: { freq: "weekly", time: "21:00", weekdays: [3] } });
    const rep = await ask(B, "@ビーグル 毎週水曜21時に配信の準備をリマインド");
    expect(rep.reply).toMatch(/^⏰ わかったわん！毎週水曜 21:00（次は .+）に、みけさんにお知らせするわん：配信の準備/);
    const list = await ask(B, "@ビーグル リマインド一覧");
    expect(list.reply).toMatch(/^覚えている予定だわん\n・\d+: 毎週水曜 21:00（次 .+）「配信の準備」$/);

    // 「教えて」でも時刻がなければリマインドではない → ふつうの答え
    aiReply = "Swift はアップルの言語だわん";
    const q = await ask(B, "@ビーグル Swift について教えて");
    expect(q.reply).toBe("Swift はアップルの言語だわん");

    // AI が none と言ったらふつうの答えへ
    aiReply = JSON.stringify({ action: "none" });
    const none = await ask(B, "@ビーグル 明日って何曜日か教えて");
    expect(none.ok).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(2);

    // 1 人 20 件まで
    await sql(
      `INSERT INTO beagle_reminders (owner_email, audience, kind, text, next_at) SELECT $1, 'me', 'at', '', now() + interval '1 day' FROM generate_series(1, 20)`,
      [A]
    );
    expect((await ask(A, "@ビーグル 5分後に教えて")).reply).toMatch(/20 件まで/);
  });

  it("繰り返しは次の回へ、長く遅れた 1 回きりは鳴らさない、会員でなくなった人のものは鳴らさない", async () => {
    const ins = await sql(
      `INSERT INTO beagle_reminders (owner_email, audience, kind, text, next_at, repeat) VALUES
        ($1, 'me', 'repeat', '毎日', now() - interval '1 minute', '{"freq":"daily","time":"08:00"}'),
        ($1, 'me', 'at', '古い', now() - interval '13 hours', NULL),
        ($2, 'me', 'at', 'もう会員でない', now() - interval '1 minute', NULL)
       RETURNING id`,
      [A, B]
    );
    await sql(`DELETE FROM sessions WHERE email = $1`, [B]);
    await m.r.fireDue();
    const dm = await sql(`SELECT recipient_email, body FROM dm_messages ORDER BY id`);
    expect(dm.rows).toEqual([{ recipient_email: A, body: "⏰ リマインドだわん：毎日" }]);
    const rows = (await sql(`SELECT id, active, next_at > now() AS future FROM beagle_reminders WHERE id = ANY($1::int[]) ORDER BY id`, [ins.rows.map((x) => x.id)])).rows;
    expect(rows.map((x) => [x.active, x.future])).toEqual([
      [true, true],
      [false, false],
      [false, false],
    ]);
    await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT DO NOTHING`, [`t-${B}`, B]);
  });
});
