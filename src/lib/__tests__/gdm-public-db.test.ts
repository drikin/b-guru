/**
 * 🌐 パブリック DM と 🗄 アーカイブの DB を通した確認（lib/gdm.ts・lib/gdm-api.ts、docs/group-dm-spec.md）。
 *
 * 本物の PostgreSQL が要る。dm-db.test.ts と同じく DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run gdm-db --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
// 写真はテスト用の一時フォルダへ（リポジトリの data/ を汚さない）
process.env.GDM_PHOTO_DIR = `${require("os").tmpdir()}/gdm-photos-test-${process.pid}`;
const d = URL_ ? describe : describe.skip;

const pushes: { to: string[]; id: number; group: number }[] = [];
const syncs: { email: string; scope: Record<string, unknown> }[] = [];
vi.mock("../push-notify", () => ({
  pushDm: async () => 1,
  pushGdm: async (to: string[], id: number, group: number) => {
    pushes.push({ to: [...to].sort(), id, group });
    return to.length;
  },
  syncRead: async (email: string, scope: Record<string, unknown>) => {
    syncs.push({ email, scope });
    return 0;
  },
}));

type Mods = {
  db: typeof import("../db");
  gdm: typeof import("../gdm");
  api: typeof import("../gdm-api");
  personal: typeof import("../personal-live");
  user: typeof import("../user");
  posts: typeof import("../posts");
};
let m: Mods;
const stamp = Date.now();
const E = (k: string) => `gdm-pub-${k}-${stamp}@test.local`;
const [A, B, C, D, OFF, NOLOGIN] = ["a", "b", "c", "d", "off", "nologin"].map(E);
type Actor = { email: string; userId: string };
let a: Actor, b: Actor, c: Actor, dd: Actor, off: Actor, nologin: Actor;
const personal: { to: string; ev: { type: string; data?: Record<string, unknown> } }[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
type G = import("../gdm").GroupDto;
type Msg = import("../gdm").GMessageDto;

async function create(actor: Actor, ids: string[], name?: string): Promise<G> {
  const r = await m.api.gdmCreateApi(actor, { name, member_ids: ids });
  expect(r.status).toBe(201);
  return r.body.group as G;
}

d("🌐 パブリック DM（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      gdm: await import("../gdm"),
      api: await import("../gdm-api"),
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
    const mk = async (e: string) => ({ email: e, userId: await m.user.ensureUserId(e) });
    [a, b, c, dd, off, nologin] = await Promise.all([A, B, C, D, OFF, NOLOGIN].map(mk));
    await m.user.ensureUserId(m.posts.SYSTEM_EMAIL);
    for (const e of [A, B, C, D, OFF]) {
      await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`gdm-test-${e}`, e]);
    }
    await sql(
      `INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ'), ($3, 'たま'), ($4, 'ぽち') ON CONFLICT DO NOTHING`,
      [A, B, C, D]
    );
    for (const u of [a, b, c, dd]) m.personal.personalBus.on(m.personal.personalKey(u.email), (ev) => personal.push({ to: u.email, ev: ev as never }));
  });

  beforeEach(async () => {
    const on = [A, B, C, D, NOLOGIN].join(",");
    process.env.DM_ENABLED = on;
    process.env.GROUP_DM_ENABLED = on;
    personal.length = 0;
    pushes.length = 0;
    syncs.length = 0;
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm:gdm-%' OR key LIKE 'gdm-admin:gdm-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'gdm-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'gdm-test-%'`);
    await m.db.pool.end();
  });

  type S = import("../gdm").GroupSummaryDto;
  async function list(actor: Actor) {
    const r = await m.api.gdmListApi(actor);
    expect(r.status).toBe(200);
    return r.body as unknown as { groups: S[]; public_groups: S[]; archived_groups: S[]; group_unread_count: number };
  }
  async function createPublic(actor: Actor, name: string | undefined, ids: string[] = []) {
    return m.api.gdmCreateApi(actor, { name, public: true, member_ids: ids });
  }
  async function send(actor: Actor, gid: number, body: string) {
    return m.api.gdmSendApi(actor, String(gid), { body });
  }

  it("パブリックは名前が必須・自分だけで作れる → 参加していない人の一覧の public_groups に出る（push しない）", async () => {
    expect((await createPublic(a, undefined)).status).toBe(400);
    const r = await createPublic(a, "雑談ひろば");
    expect(r.status).toBe(201);
    const g = r.body.group as G;
    expect(g).toMatchObject({ is_public: true, is_member: true, archived: false, member_count: 1, title: "雑談ひろば" });
    const lb = await list(b);
    expect(lb.groups).toHaveLength(0); // 古いアプリが読む groups には出さない
    expect(lb.public_groups.map((x) => x.group.id)).toEqual([g.id]);
    expect(lb.public_groups[0]).toMatchObject({ unread_count: 0, is_new: true });
    expect(lb.public_groups[0].group).toMatchObject({ is_member: false });
    expect(lb.public_groups[0].last_message?.body).toContain("パブリック DM を作りました");
    const la = await list(a);
    expect(la.groups.map((x) => x.group.id)).toEqual([g.id]);
    expect(la.public_groups).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    // プライベートは今までどおり自分だけでは作れない
    expect((await m.api.gdmCreateApi(a, { name: "x", member_ids: [] })).status).toBe(400);
    expect((await m.api.gdmCreateApi(a, { name: "x", public: "yes", member_ids: [] })).status).toBe(400);
  });

  it("参加していなくても読める（書けない・未読なし・既読は何もしない）。プライベートは 404 のまま", async () => {
    const g = (await createPublic(a, "ひろば")).body.group as G;
    await send(a, g.id, "こんにちは");
    const t = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ can_send: false, unread_count: 0 });
    expect((t.body.messages as Msg[]).map((x) => x.body)).toContain("こんにちは");
    expect((await send(b, g.id, "割り込み")).status).toBe(404);
    expect((await m.api.gdmReadApi(b, String(g.id), { last_read_id: 999999 })).status).toBe(200);
    const msgId = (t.body.messages as Msg[]).find((x) => x.body === "こんにちは")!.id;
    expect((await m.api.gdmReactApi(b, String(msgId), { emoji: "👍" })).status).toBe(404);
    expect((await m.api.gdmMessageApi(b, String(msgId))).status).toBe(404);
    const priv = await create(a, [c.userId], "ひみつ");
    expect((await m.api.gdmThreadApi(b, String(priv.id), new URLSearchParams())).status).toBe(404);
    expect((await m.api.gdmJoinApi(b, String(priv.id))).status).toBe(404);
  });

  it("参加 → 過去も見える・過去の分は未読にならない・以後は push と未読。退出しても一覧に戻る・すぐ入り直せる", async () => {
    const g = (await createPublic(a, "ひろば")).body.group as G;
    await send(a, g.id, "前の話");
    personal.length = 0;
    const j = await m.api.gdmJoinApi(b, String(g.id));
    expect(j.status).toBe(200);
    expect(j.body.group).toMatchObject({ is_member: true, member_count: 2 });
    expect(personal.some((p) => p.to === A && p.ev.data?.action === "create" && String((p.ev.data.message as Msg).body).includes("みけが参加しました"))).toBe(true);
    // 2 回目は何もしない
    expect((await m.api.gdmJoinApi(b, String(g.id))).status).toBe(200);
    const t = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    expect((t.body.messages as Msg[]).map((x) => x.body)).toContain("前の話");
    expect(t.body).toMatchObject({ unread_count: 0, can_send: true });
    expect((await list(b)).group_unread_count).toBe(0);
    pushes.length = 0;
    await send(a, g.id, "あとの話");
    await new Promise((r) => setTimeout(r, 50));
    expect(pushes.flatMap((p) => p.to)).toEqual([B]);
    expect((await list(b)).group_unread_count).toBe(1);
    // 退出（24 時間の入れ直し禁止は付けない）
    expect((await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)).status).toBe(200);
    expect((await list(b)).public_groups.map((x) => x.group.id)).toEqual([g.id]);
    expect((await m.api.gdmJoinApi(b, String(g.id))).status).toBe(200);
  });

  it("パブリックでは他人を外せない。全員抜けても消えずに一覧に残る", async () => {
    const g = (await createPublic(a, "ひろば", [b.userId])).body.group as G;
    expect((await m.api.gdmRemoveMemberApi(a, String(g.id), b.userId)).status).toBe(403);
    expect((await m.api.gdmRemoveMemberApi(a, String(g.id), a.userId)).status).toBe(200);
    expect((await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)).status).toBe(200);
    const lc = await list(c);
    expect(lc.public_groups.map((x) => x.group.id)).toEqual([g.id]);
    expect(lc.public_groups[0].group.member_count).toBe(0);
    expect((await m.api.gdmJoinApi(c, String(g.id))).status).toBe(200);
  });

  it("アーカイブ: 参加者なら誰でも・読むだけになる・全員の archived_groups へ・未読に数えない・参加者が戻せる", async () => {
    const g = (await createPublic(a, "ひろば", [b.userId])).body.group as G;
    await send(a, g.id, "未読になる");
    expect((await list(b)).group_unread_count).toBe(1);
    // 参加していない人・プライベートはアーカイブできない
    expect((await m.api.gdmUpdateApi(c, String(g.id), { archived: true })).status).toBe(404);
    const priv = await create(a, [c.userId]);
    expect((await m.api.gdmUpdateApi(a, String(priv.id), { archived: true })).status).toBe(400);
    expect((await m.api.gdmUpdateApi(b, String(g.id), { archived: "yes" })).status).toBe(400);

    const r = await m.api.gdmUpdateApi(b, String(g.id), { archived: true });
    expect(r.status).toBe(200);
    expect(r.body.group).toMatchObject({ archived: true });
    expect((r.body.group as G).archived_at).toBeTruthy();
    const lb = await list(b);
    expect(lb.groups).toHaveLength(0);
    expect(lb.group_unread_count).toBe(0);
    expect(lb.archived_groups.map((x) => x.group.id)).toEqual([g.id]);
    expect(lb.archived_groups[0].unread_count).toBe(0);
    const lc = await list(c);
    expect(lc.public_groups).toHaveLength(0);
    expect(lc.archived_groups.map((x) => x.group.id)).toEqual([g.id]);
    // 読める、書けない
    const t = await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams());
    expect(t.body).toMatchObject({ can_send: false, unread_count: 0 });
    expect((t.body.messages as Msg[]).some((x) => x.kind === "system" && x.body.includes("みけがアーカイブしました"))).toBe(true);
    expect((await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams())).status).toBe(200);
    expect((await send(a, g.id, "まだ話す")).status).toBe(403);
    expect((await m.api.gdmJoinApi(c, String(g.id))).status).toBe(403);
    expect((await m.api.gdmUpdateApi(a, String(g.id), { name: "新しい名前" })).status).toBe(403);
    expect((await m.api.gdmUpdateApi(a, String(g.id), { beagle: true })).status).toBe(403);
    expect((await m.api.gdmAddMembersApi(a, String(g.id), { user_ids: [c.userId] })).status).toBe(403);
    const msgId = (t.body.messages as Msg[]).find((x) => x.body === "未読になる")!.id;
    expect((await m.api.gdmReactApi(b, String(msgId), { emoji: "👍" })).status).toBe(403);
    expect((await m.api.gdmEditApi(a, String(msgId), { body: "直す" })).status).toBe(403);
    // 通知を切る・抜けるはできる
    expect((await m.api.gdmUpdateApi(a, String(g.id), { muted: true })).status).toBe(200);
    // 2 回押しても system 行は 1 つ
    await m.api.gdmUpdateApi(a, String(g.id), { archived: true });
    const n = (await sql(`SELECT count(*)::int AS c FROM gdm_messages WHERE group_id = $1 AND body LIKE '%アーカイブしました%'`, [g.id])).rows[0].c;
    expect(n).toBe(1);
    // 戻す（参加者なら誰でも）
    const back = await m.api.gdmUpdateApi(a, String(g.id), { archived: false });
    expect(back.status).toBe(200);
    expect(back.body.group).toMatchObject({ archived: false, archived_at: null });
    expect((await list(c)).public_groups.map((x) => x.group.id)).toEqual([g.id]);
    expect((await send(a, g.id, "再開")).status).toBe(201);
  });

  it("参加していない人もパブリックの写真を読める、プライベートは読めない", async () => {
    const g = (await createPublic(a, "ひろば")).body.group as G;
    const fs = await import("fs/promises");
    await fs.mkdir(process.env.GDM_PHOTO_DIR!, { recursive: true });
    await fs.writeFile(`${process.env.GDM_PHOTO_DIR}/g1-0123456789abcdef.webp`, Buffer.from("x"));
    await sql(`UPDATE gdm_groups SET photo = $2 WHERE id = $1`, [g.id, "g1-0123456789abcdef.webp"]);
    expect(await m.gdm.readGroupPhoto(B, g.id)).not.toBeNull();
    const priv = await create(a, [c.userId]);
    await sql(`UPDATE gdm_groups SET photo = $2 WHERE id = $1`, [priv.id, "g1-0123456789abcdef.webp"]);
    expect(await m.gdm.readGroupPhoto(B, priv.id)).toBeNull();
    expect(await m.gdm.readGroupPhoto(C, priv.id)).not.toBeNull();
  });
  it("抜けた人を他の人がすぐ追加し直すことはできない（自分で入るのは自由）。アーカイブと名前を一緒に送っても途中まで変わらない", async () => {
    const g = (await createPublic(a, "ひろば", [b.userId])).body.group as G;
    expect((await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)).status).toBe(200);
    expect((await m.api.gdmAddMembersApi(a, String(g.id), { user_ids: [b.userId] })).status).toBe(403);
    expect((await m.api.gdmJoinApi(b, String(g.id))).status).toBe(200);
    const r = await m.api.gdmUpdateApi(a, String(g.id), { archived: true, name: "別の名前" });
    expect(r.status).toBe(403);
    const t = await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams());
    expect(t.body.group).toMatchObject({ archived: false, name: "ひろば" });
  });

  it("パブリックの退出も回数に数える", async () => {
    const g = (await createPublic(a, "ひろば")).body.group as G;
    await sql(`INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 30)
               ON CONFLICT (key) DO UPDATE SET window_start = now(), count = 30`, [`gdm-admin:${C}`]);
    expect((await m.api.gdmJoinApi(c, String(g.id))).status).toBe(429);
    await sql(`UPDATE rate_limits SET count = 29 WHERE key = $1`, [`gdm-admin:${C}`]);
    expect((await m.api.gdmJoinApi(c, String(g.id))).status).toBe(200);
    expect((await m.api.gdmRemoveMemberApi(c, String(g.id), c.userId)).status).toBe(429);
  });
});
