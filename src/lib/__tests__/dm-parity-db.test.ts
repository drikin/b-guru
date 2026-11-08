/**
 * ✉️👥 DM をチャットと同じ機能に（docs/dm-chat-parity-spec.md）: 編集とリアクションを DB を通して確かめる。
 * dm-db.test.ts と同じく DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "os";

const URL_ = process.env.DM_TEST_DATABASE_URL;
process.env.DM_MEDIA_DIR = `${os.tmpdir()}/dm-parity-media-${process.pid}`;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

vi.mock("../push-notify", () => ({ pushDm: async () => 1, pushGdm: async () => 1, syncRead: async () => 0 }));

type Mods = {
  db: typeof import("../db");
  api: typeof import("../dm-api");
  gapi: typeof import("../gdm-api");
  gdm: typeof import("../gdm");
  dm: typeof import("../dm");
  user: typeof import("../user");
  live: typeof import("../personal-live");
};
let m: Mods;
const stamp = Date.now();
const A = `dpa-a-${stamp}@test.local`;
const B = `dpa-b-${stamp}@test.local`;
const C = `dpa-c-${stamp}@test.local`;
type Actor = { email: string; userId: string };
let a: Actor, b: Actor, c: Actor;
const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);

/** 本人宛ての配信を集める。 */
function collect(email: string): { events: Record<string, unknown>[]; stop: () => void } {
  const events: Record<string, unknown>[] = [];
  const key = m.live.personalKey(email);
  const fn = (ev: { type: string; data?: Record<string, unknown> }) => {
    if ((ev.type === "dm" || ev.type === "gdm") && ev.data) events.push({ type: ev.type, ...ev.data });
  };
  m.live.personalBus.on(key, fn);
  return { events, stop: () => m.live.personalBus.off(key, fn) };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

d("✉️👥 DM の編集とリアクション（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      api: await import("../dm-api"),
      gapi: await import("../gdm-api"),
      gdm: await import("../gdm"),
      dm: await import("../dm"),
      user: await import("../user"),
      live: await import("../personal-live"),
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
    for (const e of [A, B, C]) {
      await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`dpa-test-${e}`, e]);
    }
  });

  beforeEach(async () => {
    process.env.DM_ENABLED = [A, B, C].join(",");
    process.env.GROUP_DM_ENABLED = [A, B, C].join(",");
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm%:dpa-%' OR key LIKE 'dm:dpa-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM reactions WHERE user_email LIKE 'dpa-%'`);
    await sql(`DELETE FROM dm_messages WHERE sender_email LIKE 'dpa-%' OR recipient_email LIKE 'dpa-%'`);
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'dpa-%'`);
    await sql(`DELETE FROM beagle_ai_log WHERE ai_by_email LIKE 'dpa-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'dpa-test-%'`);
    await m.db.pool.end();
  });

  it("1 対 1: 送った本人だけ直せる・「編集済み」・相手にも知らせる", async () => {
    const sent = await m.api.dmSendApi(a, b.userId, { body: "こんにちわ" });
    const id = (sent.body.message as { id: number }).id;
    const seenB = collect(B);
    const r = await m.api.dmEditApi(a, String(id), { body: "こんにちは" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ id, body: "こんにちは", edited: true, is_author: true });
    await tick();
    seenB.stop();
    expect(seenB.events).toContainEqual(expect.objectContaining({ type: "dm", action: "edit", message: expect.objectContaining({ id, body: "こんにちは", is_author: false }) }));

    expect((await m.api.dmEditApi(b, String(id), { body: "乗っ取り" })).status).toBe(403);
    expect((await m.api.dmEditApi(c, String(id), { body: "第三者" })).status).toBe(404);
    expect((await m.api.dmEditApi(a, String(id), { body: "  " })).status).toBe(400);
    expect((await m.api.dmEditApi(a, String(id), null)).status).toBe(400);
    expect((await m.api.dmEditApi(a, "abc", { body: "x" })).status).toBe(400);

    const thread = await m.api.dmThreadApi(b, a.userId, new URLSearchParams());
    const got = (thread.body.messages as { id: number; body: string; edited: boolean; edited_at: string | null }[]).find((x) => x.id === id);
    expect(got).toMatchObject({ body: "こんにちは", edited: true });
    expect(got?.edited_at).toBeTruthy();
  });

  it("1 対 1: リアクションは当事者だけ・mine は見る人ごと・2 回押すと外れる", async () => {
    const sent = await m.api.dmSendApi(a, b.userId, { body: "見て" });
    const id = (sent.body.message as { id: number }).id;
    const seenA = collect(A);
    const r = await m.api.dmReactApi(b, String(id), { emoji: "👍" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ added: true, reactions: [expect.objectContaining({ emoji: "👍", count: 1, mine: true })] });
    await tick();
    seenA.stop();
    expect(seenA.events).toContainEqual(
      expect.objectContaining({ action: "reaction", message_id: id, peer_id: b.userId, reactions: [expect.objectContaining({ emoji: "👍", mine: false })] })
    );
    const thread = await m.api.dmThreadApi(a, b.userId, new URLSearchParams());
    const got = (thread.body.messages as { id: number; reactions: { emoji: string; mine: boolean }[] }[]).find((x) => x.id === id);
    expect(got?.reactions).toEqual([expect.objectContaining({ emoji: "👍", count: 1, mine: false })]);

    expect((await m.api.dmReactApi(c, String(id), { emoji: "👍" })).status).toBe(404);
    expect((await m.api.dmReactApi(b, String(id), { emoji: "これは絵文字ではない" })).status).toBe(400);
    expect((await m.api.dmReactApi(b, String(id), { emoji: ":no_such_emoji_dpa:" })).status).toBe(404);
    expect((await m.api.dmReactApi(b, String(id), {})).status).toBe(400);
    const off = await m.api.dmReactApi(b, String(id), { emoji: "👍" });
    expect(off.body).toMatchObject({ added: false, reactions: [] });
  });

  it("グループ: 直せるのは自分の発言だけ・ビーグルが答えた質問は直せない", async () => {
    const g = await m.gdm.createGroup(a, "直す会", [b.userId, c.userId]);
    const sent = await m.gdm.sendGroupMessage(a, g.id, "あした 10 じ");
    const seenC = collect(C);
    const r = await m.gapi.gdmEditApi(a, String(sent.id), { body: "あした 11 時" });
    expect(r.status).toBe(200);
    expect(r.body.message).toMatchObject({ id: sent.id, body: "あした 11 時", edited: true });
    await tick();
    seenC.stop();
    expect(seenC.events).toContainEqual(expect.objectContaining({ type: "gdm", action: "edit", group_id: g.id, message: expect.objectContaining({ id: sent.id, is_author: false }) }));
    expect((await m.gapi.gdmEditApi(b, String(sent.id), { body: "x" })).status).toBe(403);

    const q = await m.gdm.sendGroupMessage(b, g.id, "@ビーグル まとめて");
    await sql(`INSERT INTO beagle_ai_log (question_id, question_body, answer, ai_by_email, app) VALUES ($1, 'q', 'a', $2, $3)`, [q.id, B, `gdm:${g.id}`]);
    expect((await m.gapi.gdmEditApi(b, String(q.id), { body: "やっぱりいい" })).status).toBe(403);

    // 知らせ行（system）には付けられない・直せない
    const sys = await sql(`SELECT id FROM gdm_messages WHERE group_id = $1 AND kind = 'system' ORDER BY id LIMIT 1`, [g.id]);
    if (sys.rows[0]) {
      expect((await m.gapi.gdmReactApi(a, String(sys.rows[0].id), { emoji: "👍" })).status).toBe(400);
      expect((await m.gapi.gdmEditApi(a, String(sys.rows[0].id), { body: "x" })).status).toBe(403);
    }
  });

  it("グループ: リアクションはいまのメンバーで、入ってからの発言だけ・配信も見られる人だけ", async () => {
    const g = await m.gdm.createGroup(a, "反応の会", [b.userId, c.userId]);
    const old = await m.gdm.sendGroupMessage(a, g.id, "前の話");
    await m.gdm.removeMember(a, g.id, c.userId);
    expect((await m.gapi.gdmReactApi(c, String(old.id), { emoji: "👍" })).status).toBe(404);
    await m.gdm.addMembers(a, g.id, [c.userId]);
    // 入り直した C は入る前の発言を見られないので、付けられないし配信も来ない
    expect((await m.gapi.gdmReactApi(c, String(old.id), { emoji: "👍" })).status).toBe(404);
    const seenC = collect(C);
    const r = await m.gapi.gdmReactApi(b, String(old.id), { emoji: "🎉" });
    expect(r.status).toBe(200);
    await tick();
    seenC.stop();
    expect(seenC.events.filter((e) => e.action === "reaction")).toEqual([]);

    const fresh = await m.gdm.sendGroupMessage(a, g.id, "入ってから");
    const seenA = collect(A);
    expect((await m.gapi.gdmReactApi(c, String(fresh.id), { emoji: "🎉" })).status).toBe(200);
    await tick();
    seenA.stop();
    expect(seenA.events).toContainEqual(
      expect.objectContaining({ action: "reaction", group_id: g.id, message_id: fresh.id, reactions: [expect.objectContaining({ emoji: "🎉", mine: false })] })
    );
    const thread = await m.gapi.gdmThreadApi(a, String(g.id), new URLSearchParams());
    const got = (thread.body.messages as { id: number; reactions: unknown[] }[]).find((x) => x.id === fresh.id);
    expect(got?.reactions).toEqual([expect.objectContaining({ emoji: "🎉", count: 1, mine: false })]);
  });

  it("消えた発言のリアクションは掃除で消える", async () => {
    const sent = await m.api.dmSendApi(a, b.userId, { body: "消える" });
    const id = (sent.body.message as { id: number }).id;
    await m.api.dmReactApi(b, String(id), { emoji: "👋" });
    await sql(`UPDATE dm_messages SET created_at = now() - interval '31 days' WHERE id = $1`, [id]);
    await m.dm.purgeExpiredDm();
    const left = await sql(`SELECT 1 FROM reactions WHERE target_type = 'dm' AND target_id = $1`, [id]);
    expect(left.rowCount).toBe(0);
  });

  it("capabilities に edit / reactions", () => {
    expect(m.dm.dmCapability(true, ["read", "chat"])).toMatchObject({ edit: true, reactions: true });
    expect(m.gdm.gdmCapability(true, ["read", "chat"])).toMatchObject({ edit: true, reactions: true });
  });
});
