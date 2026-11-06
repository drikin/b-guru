/**
 * 👥 グループ DM の DB を通した確認（lib/gdm.ts・lib/gdm-api.ts、docs/group-dm-spec.md）。
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
const E = (k: string) => `gdm-${k}-${stamp}@test.local`;
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

d("👥 グループ DM（DB）", () => {
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

  it("作る → 全員の一覧に出る、作った人と system 行、メールは出ない", async () => {
    const g = await create(a, [b.userId, c.userId, a.userId, b.userId], "  旅行  ");
    expect(g).toMatchObject({ name: "旅行", title: "旅行", member_count: 3, is_creator: true, muted: false });
    expect(g.members.map((x) => x.user_id).sort()).toEqual([a.userId, b.userId, c.userId].sort());
    expect(g.members.find((x) => x.user_id === a.userId)).toMatchObject({ is_creator: true, is_me: true });
    expect(g.members.filter((x) => x.is_me)).toHaveLength(1);

    const listB = await m.api.gdmListApi(b);
    expect(listB.status).toBe(200);
    const groups = listB.body.groups as import("../gdm").GroupSummaryDto[];
    expect(groups).toHaveLength(1);
    expect(groups[0].group).toMatchObject({ id: g.id, is_creator: false });
    expect(groups[0].last_message).toMatchObject({ kind: "system", from_id: null });
    expect(groups[0].last_message?.body).toContain("ねこがグループを作りました");
    expect(groups[0].unread_count).toBe(0); // system 行は未読に数えない
    expect(JSON.stringify(listB.body)).not.toContain("@test.local");
    expect(JSON.stringify(personal.map((p) => p.ev))).not.toContain("@test.local");
    // 新しいメンバーには、発言より先にグループが届く
    const forC = personal.filter((p) => p.to === C).map((p) => p.ev.data?.action);
    expect(forC.indexOf("group")).toBeLessThan(forC.indexOf("create"));
    expect(pushes).toHaveLength(0); // system 行は push しない
  });

  it("名前なしは他のメンバーの名前を並べる", async () => {
    const g = await create(a, [b.userId, c.userId]);
    expect(g.name).toBeNull();
    expect(g.title).toBe("みけ、たま");
    expect(m.gdm.groupTitle(null, ["a", "b", "c", "d", "e"])).toBe("a、b、c ほか 2 人");
    expect(m.gdm.groupTitle(null, [])).toBe("（自分だけ）");
  });

  it("送る → 全員に配信、送った人と通知を切った人以外へ push、未読と既読（単調）", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await m.api.gdmUpdateApi(c, String(g.id), { muted: true });
    personal.length = 0;
    const sent = await m.api.gdmSendApi(a, String(g.id), { body: " やあ \r\n", client_id: "x1", from_id: c.userId });
    expect(sent.status).toBe(201);
    const msg = sent.body.message as Msg;
    expect(msg).toMatchObject({ kind: "text", from_id: a.userId, from_name: "ねこ", body: "やあ", is_author: true, client_id: "x1" });
    await vi.waitFor(() => expect(pushes).toEqual([{ to: [B], id: msg.id, group: g.id }])); // push は会員かを確かめてから
    const toB = personal.find((p) => p.to === B && p.ev.data?.action === "create");
    expect((toB?.ev.data?.message as Msg).is_author).toBe(false);
    expect((toB?.ev.data?.message as Msg).client_id).toBeUndefined();
    expect(toB?.ev.data?.group_unread_count).toBe(1);

    const th = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    expect(th.body.unread_count).toBe(1);
    expect(th.body.can_send).toBe(true);
    const r1 = await m.api.gdmReadApi(b, String(g.id), { last_read_id: msg.id });
    expect(r1.body).toMatchObject({ unread_count: 0, group_unread_count: 0 });
    await m.api.gdmReadApi(b, String(g.id), { last_read_id: 1 });
    expect((await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams())).body.unread_count).toBe(0);
    expect(syncs.some((s) => s.email === B && s.scope.scope === "gdm" && s.scope.group_id === g.id)).toBe(true);
    // 送った側は既読
    expect((await m.api.gdmListApi(a)).body.group_unread_count).toBe(0);
    // client_id の再送は 2 重に入らない
    const again = await m.api.gdmSendApi(a, String(g.id), { body: "やあ", client_id: "x1" });
    expect((again.body.message as Msg).id).toBe(msg.id);
  });

  it("メンバー以外は読めない・送れない・1 件も取れない（404）", async () => {
    const g = await create(a, [b.userId]);
    const sent = await m.gdm.sendGroupMessage(a, g.id, "ひみつ");
    expect((await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams())).status).toBe(404);
    expect((await m.api.gdmSendApi(c, String(g.id), { body: "x" })).status).toBe(404);
    expect((await m.api.gdmMessageApi(c, String(sent.id))).status).toBe(404);
    expect((await m.api.gdmMessageApi(b, String(sent.id))).status).toBe(200);
    expect((await m.api.gdmAddMembersApi(c, String(g.id), { user_ids: [dd.userId] })).status).toBe(404);
    expect((await m.api.gdmThreadApi(a, "abc", new URLSearchParams())).status).toBe(400);
  });

  it("追加は誰でも・入る前の発言は見えない・外すのは作った人だけ・抜けるのは誰でも", async () => {
    const g = await create(a, [b.userId]);
    const before = await m.gdm.sendGroupMessage(a, g.id, "入る前");
    const add = await m.api.gdmAddMembersApi(b, String(g.id), { user_ids: [c.userId] }); // 作った人でなくても追加できる
    expect(add.status).toBe(200);
    expect((add.body.group as G).member_count).toBe(3);
    const thC = await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams());
    const bodies = (thC.body.messages as Msg[]).map((x) => x.body);
    expect(bodies).not.toContain("入る前");
    expect(bodies.some((x) => x.includes("みけがたまを追加しました"))).toBe(true);
    expect((await m.api.gdmMessageApi(c, String(before.id))).status).toBe(404);

    // 作った人でない人は外せない
    expect((await m.api.gdmRemoveMemberApi(b, String(g.id), c.userId)).status).toBe(403);
    // 作った人は外せる → 外された人は見えなくなり、removed が届く
    personal.length = 0;
    expect((await m.api.gdmRemoveMemberApi(a, String(g.id), c.userId)).status).toBe(200);
    expect(personal.some((p) => p.to === C && p.ev.data?.action === "removed")).toBe(true);
    expect((await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams())).status).toBe(404);
    expect(((await m.api.gdmListApi(c)).body.groups as unknown[]).length).toBe(0);
    // 抜けるのは誰でも
    expect((await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)).status).toBe(200);
    const thA = await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams());
    expect((thA.body.messages as Msg[]).some((x) => x.body === "みけが抜けました")).toBe(true);
  });

  it("作った人が抜けると、いちばん早く入った人へ。0 人でグループごと消える", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await m.api.gdmRemoveMemberApi(a, String(g.id), a.userId);
    const thB = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    expect((thB.body.group as G).is_creator).toBe(true);
    await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId);
    await m.api.gdmRemoveMemberApi(c, String(g.id), c.userId);
    expect((await sql(`SELECT 1 FROM gdm_groups WHERE id = $1`, [g.id])).rowCount).toBe(0);
    expect((await sql(`SELECT 1 FROM gdm_messages WHERE group_id = $1`, [g.id])).rowCount).toBe(0);
  });

  it("入れられない人: 自分だけ・ビーグル・使えない人・ログインしていない人・知らない人", async () => {
    expect((await m.api.gdmCreateApi(a, { member_ids: [a.userId] })).status).toBe(400);
    expect((await m.api.gdmCreateApi(a, { member_ids: [] })).status).toBe(400);
    const sys = await m.user.ensureUserId(m.posts.SYSTEM_EMAIL);
    expect((await m.api.gdmCreateApi(a, { member_ids: [sys] })).status).toBe(404);
    expect((await m.api.gdmCreateApi(a, { member_ids: [off.userId] })).status).toBe(403);
    expect((await m.api.gdmCreateApi(a, { member_ids: [nologin.userId] })).status).toBe(403);
    expect((await m.api.gdmCreateApi(a, { member_ids: ["nobody_xyz"] })).status).toBe(404);
    expect((await m.api.gdmCreateApi(a, { member_ids: ["bad id!"] })).status).toBe(400);
    expect((await m.api.gdmCreateApi(a, { member_ids: [b.userId], name: "あ".repeat(41) })).status).toBe(400);
    // 本人が対象外なら機能ごと 404
    expect((await m.api.gdmListApi(off)).status).toBe(404);
  });

  it("名前の変更（誰でも）と mute（自分だけ）", async () => {
    const g = await create(a, [b.userId]);
    personal.length = 0;
    const r = await m.api.gdmUpdateApi(b, String(g.id), { name: "部活" });
    expect((r.body.group as G).name).toBe("部活");
    expect(personal.some((p) => p.to === A && p.ev.data?.action === "group")).toBe(true);
    const mu = await m.api.gdmUpdateApi(b, String(g.id), { muted: true });
    expect((mu.body.group as G).muted).toBe(true);
    expect(((await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams())).body.group as G).muted).toBe(false);
    expect((await m.api.gdmUpdateApi(b, String(g.id), { muted: "yes" })).status).toBe(400);
  });

  it("人数の安全弁（100 人）", async () => {
    const g = await create(a, [b.userId]);
    await sql(
      `INSERT INTO gdm_members (group_id, email) SELECT $1, 'gdm-filler-' || i || '-${stamp}@test.local' FROM generate_series(1, 98) i`,
      [g.id]
    );
    const r = await m.api.gdmAddMembersApi(a, String(g.id), { user_ids: [c.userId] });
    expect(r.status).toBe(400);
  });

  it("自分で抜けた人は 24 時間入れ直せない（外された人は入れ直せる）", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId);
    const again = await m.api.gdmAddMembersApi(c, String(g.id), { user_ids: [b.userId] });
    expect(again.status).toBe(403);
    await sql(`UPDATE gdm_leaves SET left_at = now() - interval '25 hours' WHERE group_id = $1`, [g.id]);
    expect((await m.api.gdmAddMembersApi(c, String(g.id), { user_ids: [b.userId] })).status).toBe(200);
    await m.api.gdmRemoveMemberApi(a, String(g.id), c.userId); // 外されただけ
    expect((await m.api.gdmAddMembersApi(b, String(g.id), { user_ids: [c.userId] })).status).toBe(200);
  });

  it("名前の変更も回数制限（作る・追加と同じ 30 回/時）", async () => {
    const g = await create(a, [b.userId]); // 1 回目
    for (let i = 0; i < 29; i++) expect((await m.api.gdmUpdateApi(a, String(g.id), { name: `n${i}` })).status).toBe(200);
    const over = await m.api.gdmUpdateApi(a, String(g.id), { name: "over" });
    expect(over.status).toBe(429);
    expect(over.headers?.["Retry-After"]).toBeTruthy();
    // mute は数えない
    expect((await m.api.gdmUpdateApi(a, String(g.id), { muted: true })).status).toBe(200);
  });

  it("作った人と最古のメンバーが同時に抜けても、作った人は残っている人になる", async () => {
    const g = await create(a, [b.userId, c.userId]);
    await Promise.all([m.api.gdmRemoveMemberApi(a, String(g.id), a.userId), m.api.gdmRemoveMemberApi(b, String(g.id), b.userId)]);
    const th = await m.api.gdmThreadApi(c, String(g.id), new URLSearchParams());
    expect((th.body.group as G).is_creator).toBe(true);
  });

  it("グループの写真: メンバーなら誰でも設定・外せる、メンバーだけ読める、グループが消えるとファイルも消える", async () => {
    const sharp = (await import("sharp")).default;
    const { readdir } = await import("fs/promises");
    const png = await sharp({ create: { width: 1200, height: 800, channels: 3, background: { r: 200, g: 50, b: 50 } } }).png().toBuffer();
    const g = await create(a, [b.userId]);
    personal.length = 0;
    const set = await m.gdm.setGroupPhoto(b, g.id, png, "image/png"); // 作った人でなくても
    expect(set.photo).toMatch(new RegExp(`^/api/gdm/${g.id}/photo\\?v=[a-f0-9]{16}$`));
    expect(personal.some((p) => p.to === A && p.ev.data?.action === "group")).toBe(true);
    const img = await m.gdm.readGroupPhoto(A, g.id);
    expect(img).not.toBeNull();
    const meta = await sharp(img!).metadata();
    expect([meta.format, meta.width, meta.height, meta.exif]).toEqual(["webp", 512, 512, undefined]);
    expect(await m.gdm.readGroupPhoto(C, g.id)).toBeNull(); // メンバー以外は読めない
    const th = await m.api.gdmThreadApi(a, String(g.id), new URLSearchParams());
    expect((th.body.messages as Msg[]).some((x) => x.body === "みけがグループの写真を変えました")).toBe(true);
    // 取り替えると前のファイルは消える
    const again = await m.gdm.setGroupPhoto(a, g.id, png, "image/png");
    expect(again.photo).not.toBe(set.photo);
    const dir = m.gdm.gdmPhotoDir();
    expect((await readdir(dir)).filter((f) => f.startsWith(`g${g.id}-`))).toHaveLength(1);
    // 読めない中身・違う種類は 400
    await expect(m.gdm.setGroupPhoto(a, g.id, Buffer.from("not an image"), "image/png")).rejects.toMatchObject({ status: 400 });
    await expect(m.gdm.setGroupPhoto(a, g.id, png, "image/gif")).rejects.toMatchObject({ status: 400 });
    await expect(m.gdm.setGroupPhoto(c, g.id, png, "image/png")).rejects.toMatchObject({ status: 404 });
    // 外す
    expect((await m.gdm.removeGroupPhoto(b, g.id)).photo).toBeNull();
    expect((await readdir(dir)).filter((f) => f.startsWith(`g${g.id}-`))).toHaveLength(0);
    // 0 人でグループが消えるとファイルも消える
    await m.gdm.setGroupPhoto(a, g.id, png, "image/png");
    await m.api.gdmRemoveMemberApi(a, String(g.id), a.userId);
    await m.api.gdmRemoveMemberApi(b, String(g.id), b.userId);
    expect((await readdir(dir)).filter((f) => f.startsWith(`g${g.id}-`))).toHaveLength(0);
  });

  it("30 日を過ぎた発言は見えず、掃除で消える", async () => {
    const g = await create(a, [b.userId]);
    const old = await m.gdm.sendGroupMessage(a, g.id, "古い");
    await sql(`UPDATE gdm_messages SET created_at = now() - interval '31 days' WHERE id = $1`, [old.id]);
    const th = await m.api.gdmThreadApi(b, String(g.id), new URLSearchParams());
    expect((th.body.messages as Msg[]).map((x) => x.body)).not.toContain("古い");
    const dmMod = await import("../dm");
    await dmMod.purgeExpiredDm();
    expect((await sql(`SELECT 1 FROM gdm_messages WHERE id = $1`, [old.id])).rowCount).toBe(0);
  });
});
