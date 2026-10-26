/**
 * ✉️ 簡易 DM の DB を通した確認（lib/dm.ts・lib/dm-api.ts・Web の /api/dm）。
 *
 * 本物の PostgreSQL が要る。事故を避けるため DATABASE_URL ではなく専用の
 * DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと。テーブルを作り、行を消す）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run dm-db
 *
 *  - 送る → 相手の一覧・会話に出る（未読つき）、既読で減る（単調）、配信は受け取る人ごとの DTO（メールなし）
 *  - 当事者以外は読めない（1 件の取得も 404）、自分・B-guru・知らない人には送れない
 *  - 送り主はサーバが決める（本文に混ぜた from_id などは無視）
 *  - 相手が DM_ENABLED の対象外・ログインしていない → 403、本人が対象外 → 404
 *  - 1 時間 60 件まで（61 件目は 429）、本文の上限（1000 字）
 *  - 24 時間を過ぎたものは見えず、掃除で消える
 *  - client_id の再送は 2 重に入れない、通知（pushDm）は相手へ 1 回
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

const pushes: { to: string; id: number; from: string }[] = [];
vi.mock("../push-notify", () => ({
  pushDm: async (to: string, id: number, from: string) => {
    pushes.push({ to, id, from });
    return 1;
  },
  syncRead: async () => 0,
}));
const web = { email: "" };
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => web.email || null }));

type Mods = {
  db: typeof import("../db");
  dm: typeof import("../dm");
  api: typeof import("../dm-api");
  personal: typeof import("../personal-live");
  user: typeof import("../user");
  posts: typeof import("../posts");
};
let m: Mods;
const stamp = Date.now();
const A = `dm-a-${stamp}@test.local`;
const B = `dm-b-${stamp}@test.local`;
const C = `dm-c-${stamp}@test.local`;
const OFF = `dm-off-${stamp}@test.local`;
let a: { email: string; userId: string };
let b: { email: string; userId: string };
let c: { email: string; userId: string };
let off: { email: string; userId: string };
const personal: { to: string; ev: { type: string; data?: Record<string, unknown> } }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
async function login(email: string) {
  await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`dm-test-${email}`, email]);
}

d("✉️ 簡易 DM（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      dm: await import("../dm"),
      api: await import("../dm-api"),
      personal: await import("../personal-live"),
      user: await import("../user"),
      posts: await import("../posts"),
    };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
    a = { email: A, userId: await m.user.ensureUserId(A) };
    b = { email: B, userId: await m.user.ensureUserId(B) };
    c = { email: C, userId: await m.user.ensureUserId(C) };
    off = { email: OFF, userId: await m.user.ensureUserId(OFF) };
    await m.user.ensureUserId(m.posts.SYSTEM_EMAIL);
    for (const e of [A, B, C, OFF]) await login(e);
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ') ON CONFLICT DO NOTHING`, [A, B]);
    for (const u of [a, b, c]) m.personal.personalBus.on(m.personal.personalKey(u.email), (ev) => personal.push({ to: u.email, ev: ev as never }));
  });

  beforeEach(async () => {
    process.env.DM_ENABLED = [A, B, C].join(",");
    personal.length = 0;
    pushes.length = 0;
    web.email = "";
    await sql(`DELETE FROM dm_messages WHERE sender_email LIKE 'dm-%' OR recipient_email LIKE 'dm-%'`);
    await sql(`DELETE FROM dm_read_state WHERE email LIKE 'dm-%'`);
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm:dm-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM dm_messages WHERE sender_email LIKE 'dm-%' OR recipient_email LIKE 'dm-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'dm-test-%'`);
    await m.db.pool.end();
  });

  it("送る → 相手の一覧と会話に未読つきで出る、既読で減る（単調）", async () => {
    const sent = await m.api.dmSendApi(a, b.userId, { body: "  こんにちは \r\n2 行目 ", client_id: "c1" });
    expect(sent.status).toBe(201);
    const msg = sent.body.message as import("../dm").DmMessageDto;
    expect(msg).toMatchObject({ from_id: a.userId, to_id: b.userId, peer_id: b.userId, body: "こんにちは \n2 行目", is_author: true, client_id: "c1" });

    const listB = await m.api.dmListApi(b);
    expect(listB.status).toBe(200);
    expect(listB.body.unread_count).toBe(1);
    const conv = (listB.body.conversations as import("../dm").DmConversationDto[])[0];
    expect(conv.peer).toMatchObject({ user_id: a.userId, name: "ねこ" });
    expect(conv.unread_count).toBe(1);
    expect(conv.last_message).toMatchObject({ is_author: false, peer_id: a.userId });
    expect(conv.last_message.client_id).toBeUndefined(); // 相手には送り主の client_id を出さない

    // 送った側は「そこまで見た」
    expect((await m.api.dmListApi(a)).body.unread_count).toBe(0);

    await m.dm.sendDm(a, b.userId, "もう 1 通");
    const thread = await m.api.dmThreadApi(b, a.userId, new URLSearchParams());
    expect(thread.body.unread_count).toBe(2);
    expect(thread.body.can_send).toBe(true);
    const msgs = thread.body.messages as import("../dm").DmMessageDto[];
    expect(msgs.map((x) => x.body)).toEqual(["こんにちは \n2 行目", "もう 1 通"]);

    const r1 = await m.api.dmReadApi(b, a.userId, { last_read_id: msgs[0].id });
    expect(r1.body.unread_count).toBe(1);
    const r2 = await m.api.dmReadApi(b, a.userId, { last_read_id: msgs[1].id });
    expect(r2.body.unread_count).toBe(0);
    // 古い ID を送っても巻き戻らない
    const r3 = await m.api.dmReadApi(b, a.userId, { last_read_id: 1 });
    expect(r3.body.unread_count).toBe(0);
    // 既読はほかの端末へ
    expect(personal.some((p) => p.to === B && p.ev.type === "dm" && p.ev.data?.action === "read")).toBe(true);
  });

  it("配信: 送り主と相手に、それぞれから見た DTO（メールなし）。通知は相手へ 1 回", async () => {
    await m.dm.sendDm(a, b.userId, "やあ", "cid-9");
    await new Promise((r) => setTimeout(r, 50));
    const toA = personal.find((p) => p.to === A && p.ev.data?.action === "create")!;
    const toB = personal.find((p) => p.to === B && p.ev.data?.action === "create")!;
    expect(toA.ev.data).toMatchObject({ message: { is_author: true, client_id: "cid-9", peer_id: b.userId }, peer: { user_id: b.userId } });
    expect(toB.ev.data).toMatchObject({ message: { is_author: false, peer_id: a.userId }, peer: { user_id: a.userId, name: "ねこ" }, unread_count: 1 });
    expect((toB.ev.data!.message as Record<string, unknown>).client_id).toBeUndefined();
    const json = JSON.stringify(personal.map((p) => p.ev)); // the routing key (email) is not part of the payload
    expect(json).not.toContain(A);
    expect(json).not.toContain(B);
    expect(json).not.toContain("@test.local");
    expect(pushes).toEqual([{ to: B, id: (toB.ev.data!.message as { id: number }).id, from: a.userId }]);
  });

  it("当事者以外は読めない（会話には出ない・1 件の取得は 404）", async () => {
    const sent = await m.dm.sendDm(a, b.userId, "ひみつ");
    const fromC = await m.api.dmThreadApi(c, a.userId, new URLSearchParams());
    expect(fromC.body.messages).toEqual([]);
    expect((await m.api.dmListApi(c)).body.conversations).toEqual([]);
    expect((await m.api.dmMessageApi(c, String(sent.id))).status).toBe(404);
    const own = await m.api.dmMessageApi(b, String(sent.id));
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ message: { body: "ひみつ", is_author: false }, peer: { user_id: a.userId } });
    expect((await m.api.dmMessageApi(b, "abc")).status).toBe(400);
  });

  it("送り主はサーバが決める（本文側の from_id などは無視）", async () => {
    const r = await m.api.dmSendApi(a, b.userId, { body: "x", from_id: c.userId, sender_email: C });
    expect(r.status).toBe(201);
    const row = await sql(`SELECT sender_email FROM dm_messages WHERE id = $1`, [(r.body.message as { id: number }).id]);
    expect(row.rows[0].sender_email).toBe(A);
  });

  it("送れない相手: 自分・B-guru・知らない ID・不正な ID", async () => {
    expect((await m.api.dmSendApi(a, a.userId, { body: "x" })).status).toBe(400);
    const sys = await m.user.emailToUserId(m.posts.SYSTEM_EMAIL);
    expect((await m.api.dmSendApi(a, sys!, { body: "x" })).status).toBe(404);
    expect((await m.api.dmSendApi(a, "nobody123456", { body: "x" })).status).toBe(404);
    expect((await m.api.dmSendApi(a, "../etc", { body: "x" })).status).toBe(400);
    expect((await m.api.dmSendApi(a, b.userId, null)).status).toBe(400);
  });

  it("DM_ENABLED: 本人が対象外は 404、相手が対象外・ログインしていないは 403", async () => {
    expect((await m.api.dmListApi(off)).status).toBe(404);
    expect((await m.api.dmSendApi(off, a.userId, { body: "x" })).status).toBe(404);
    const toOff = await m.api.dmSendApi(a, off.userId, { body: "x" });
    expect(toOff.status).toBe(403);
    expect((await m.api.dmThreadApi(a, off.userId, new URLSearchParams())).body.can_send).toBe(false);
    await sql(`DELETE FROM sessions WHERE email = $1`, [C]);
    expect((await m.api.dmSendApi(a, c.userId, { body: "x" })).status).toBe(403);
    await login(C);
    process.env.DM_ENABLED = "1";
    expect((await m.api.dmSendApi(a, off.userId, { body: "x" })).status).toBe(201);
  });

  it("本文: 空・長すぎは 400（チャットと同じ 1000 字まで）", async () => {
    expect((await m.api.dmSendApi(a, b.userId, { body: "   " })).status).toBe(400);
    expect((await m.api.dmSendApi(a, b.userId, { body: "あ".repeat(1001) })).status).toBe(400);
    expect((await m.api.dmSendApi(a, b.userId, { body: "あ".repeat(1000) })).status).toBe(201);
    expect((await m.api.dmSendApi(a, b.userId, { body: 123 })).status).toBe(400);
  });

  it("1 時間 60 件まで、61 件目は 429（Retry-After つき）", async () => {
    for (let i = 0; i < 60; i++) await m.dm.sendDm(a, b.userId, `n${i}`);
    const over = await m.api.dmSendApi(a, b.userId, { body: "over" });
    expect(over.status).toBe(429);
    expect(over.body.code).toBe("rate_limited");
    expect(Number(over.headers?.["Retry-After"])).toBeGreaterThan(0);
    // 相手からの返事は別のカウンタ
    expect((await m.api.dmSendApi(b, a.userId, { body: "ok" })).status).toBe(201);
  });

  it("client_id の再送は 2 重に入れない", async () => {
    const [x, y] = await Promise.all([m.dm.sendDm(a, b.userId, "1 回", "dup-1"), m.dm.sendDm(a, b.userId, "1 回", "dup-1")]);
    expect(x.id).toBe(y.id);
    const n = await sql(`SELECT count(*)::int AS c FROM dm_messages WHERE sender_email = $1`, [A]);
    expect(n.rows[0].c).toBe(1);
  });

  it("24 時間を過ぎたものは見えず、掃除で消える（古い既読の記録も）", async () => {
    const old = await m.dm.sendDm(a, b.userId, "むかし");
    const fresh = await m.dm.sendDm(a, b.userId, "いま");
    await sql(`UPDATE dm_messages SET created_at = now() - interval '25 hours' WHERE id = $1`, [old.id]);
    await sql(`UPDATE dm_read_state SET updated_at = now() - interval '26 hours' WHERE email = $1`, [A]);
    const t = await m.api.dmThreadApi(b, a.userId, new URLSearchParams());
    expect((t.body.messages as { id: number }[]).map((x) => x.id)).toEqual([fresh.id]);
    expect((await m.api.dmListApi(b)).body.unread_count).toBe(1);
    expect((await m.api.dmMessageApi(b, String(old.id))).status).toBe(404);
    await m.dm.purgeExpiredDm();
    expect((await sql(`SELECT 1 FROM dm_messages WHERE id = $1`, [old.id])).rowCount).toBe(0);
    expect((await sql(`SELECT 1 FROM dm_messages WHERE id = $1`, [fresh.id])).rowCount).toBe(1);
    expect((await sql(`SELECT 1 FROM dm_read_state WHERE email = $1`, [A])).rowCount).toBe(0);
  });

  it("Web の /api/dm（セッション）: 未ログインは 401、送って一覧に出る", async () => {
    const list = await import("../../app/api/dm/route");
    const thread = await import("../../app/api/dm/[userId]/route");
    const read = await import("../../app/api/dm/[userId]/read/route");
    expect((await list.GET()).status).toBe(401);
    web.email = A;
    const post = await thread.POST(
      new Request("http://x/api/dm/" + b.userId, { method: "POST", body: JSON.stringify({ body: "web から" }) }) as never,
      { params: Promise.resolve({ userId: b.userId }) }
    );
    expect(post.status).toBe(201);
    const text = await post.text();
    expect(text).not.toContain("@test.local");
    web.email = B;
    const got = await list.GET();
    const body = await got.json();
    expect(body.unread_count).toBe(1);
    const mid = body.conversations[0].last_message.id;
    const r = await read.POST(
      new Request("http://x", { method: "POST", body: JSON.stringify({ last_read_id: mid }) }) as never,
      { params: Promise.resolve({ userId: a.userId }) }
    );
    expect((await r.json()).unread_count).toBe(0);
  });
});
