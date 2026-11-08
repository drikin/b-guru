/**
 * ✉️👥 DM の写真（lib/dm-media.ts、docs/dm-photos-spec.md）を DB を通して確かめる。
 * dm-db.test.ts と同じく DM_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *
 *  - 自分が上げた写真を付けて送れる・写真だけ（本文なし）も送れる・DTO と配信に images
 *  - 他人が上げた写真・形の違う URL・5 枚以上は 400
 *  - 見られるのは当事者・上げた本人・グループのいまのメンバーだけ（外された人・第三者は見られない）
 *  - 送られなかった写真は 1 日、送った写真は DM の期限＋1 日で消える
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import os from "os";
import path from "path";
import { mkdtemp, writeFile, stat } from "fs/promises";

const URL_ = process.env.DM_TEST_DATABASE_URL;
const MEDIA = `${os.tmpdir()}/dm-media-test-${process.pid}`;
process.env.DM_MEDIA_DIR = MEDIA;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

vi.mock("../push-notify", () => ({ pushDm: async () => 1, pushGdm: async () => 1, syncRead: async () => 0 }));

type Mods = {
  db: typeof import("../db");
  dm: typeof import("../dm");
  api: typeof import("../dm-api");
  gdm: typeof import("../gdm");
  media: typeof import("../dm-media");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `dmp-a-${stamp}@test.local`;
const B = `dmp-b-${stamp}@test.local`;
const C = `dmp-c-${stamp}@test.local`;
let a: { email: string; userId: string };
let b: { email: string; userId: string };
let c: { email: string; userId: string };
let cwd: string;
let seq = 0;

const sql = (q: string, p: unknown[] = []) => m.db.pool.query(q, p);
const newUrl = () => `/api/media/dm-${stamp}-${++seq}abc.jpg`;
async function upload(email: string, n = 1): Promise<string[]> {
  const urls = Array.from({ length: n }, newUrl);
  const { mkdir } = await import("fs/promises");
  await mkdir(path.join(process.cwd(), "public", "uploads"), { recursive: true });
  for (const u of urls) await writeFile(path.join(process.cwd(), "public", "uploads", file(u)), "x");
  await m.media.recordDmUploads(email, urls);
  return urls;
}
const file = (url: string) => url.slice("/api/media/".length);

d("✉️👥 DM の写真（DB）", () => {
  beforeAll(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "dm-photos-"));
    process.chdir(cwd); // 上げた写真（public/uploads → DM_MEDIA_DIR）を使い捨ての場所で
    m = {
      db: await import("../db"),
      dm: await import("../dm"),
      api: await import("../dm-api"),
      gdm: await import("../gdm"),
      media: await import("../dm-media"),
      user: await import("../user"),
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
      await sql(`INSERT INTO sessions (token, email, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [`dmp-test-${e}`, e]);
    }
  });

  beforeEach(async () => {
    process.env.DM_ENABLED = [A, B, C].join(",");
    process.env.GROUP_DM_ENABLED = [A, B, C].join(",");
    await sql(`DELETE FROM rate_limits WHERE key LIKE 'dm:dmp-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM dm_messages WHERE sender_email LIKE 'dmp-%' OR recipient_email LIKE 'dmp-%'`);
    await sql(`DELETE FROM dm_uploads WHERE uploader_email LIKE 'dmp-%'`);
    await sql(`DELETE FROM gdm_groups WHERE creator_email LIKE 'dmp-%'`);
    await sql(`DELETE FROM sessions WHERE token LIKE 'dmp-test-%'`);
    await m.db.pool.end();
  });

  it("自分の写真を付けて送れる・写真だけも送れる・見られるのは当事者と上げた本人だけ", async () => {
    const [p1, p2] = await upload(A, 2);
    expect(await m.media.canViewDmMedia(A, file(p1))).toBe(true); // 上げた本人（送る前）
    expect(await m.media.canViewDmMedia(B, file(p1))).toBe(false); // 送る前は相手も見られない

    const r = await m.api.dmSendApi(a, b.userId, { body: "", images: [p1, p2, p1] });
    expect(r.status).toBe(201);
    const msg = r.body.message as import("../dm").DmMessageDto;
    expect(msg.body).toBe("");
    expect(msg.images).toEqual([p1, p2]);

    const thread = await m.api.dmThreadApi(b, a.userId, new URLSearchParams());
    const got = (thread.body.messages as import("../dm").DmMessageDto[]).find((x) => x.id === msg.id);
    expect(got?.images).toEqual([p1, p2]);
    const list = await m.api.dmListApi(b);
    const conv = (list.body.conversations as import("../dm").DmConversationDto[]).find((x) => x.peer.user_id === a.userId);
    expect(conv?.last_message.images).toEqual([p1, p2]);

    expect(await m.media.canViewDmMedia(B, file(p1))).toBe(true);
    expect(await m.media.canViewDmMedia(C, file(p1))).toBe(false);
    expect(await m.media.canViewDmMedia(C, "dm-../../etc/passwd")).toBe(false);
  });

  it("他人の写真・形の違う URL・5 枚以上・本文も写真も無しは 400", async () => {
    const [theirs] = await upload(B);
    expect((await m.api.dmSendApi(a, c.userId, { body: "見て", images: [theirs] })).status).toBe(400);
    expect((await m.api.dmSendApi(a, c.userId, { body: "x", images: ["/api/media/chat-1-abc.jpg"] })).status).toBe(400);
    expect((await m.api.dmSendApi(a, c.userId, { body: "x", images: "nope" })).status).toBe(400);
    expect((await m.api.dmSendApi(a, c.userId, { body: "x", images: await upload(A, 5) })).status).toBe(400);
    expect((await m.api.dmSendApi(a, c.userId, { body: "  ", images: [] })).status).toBe(400);
    // 上げてから 1 日を過ぎた写真は付けられない（発言より先に掃除で消えるため）
    const [old] = await upload(A);
    await sql(`UPDATE dm_uploads SET created_at = now() - interval '2 days' WHERE name = $1`, [file(old)]);
    expect((await m.api.dmSendApi(a, c.userId, { body: "x", images: [old] })).status).toBe(400);
    // 写真は public の外へ移されている
    const there = async (d: string, u: string) => stat(path.join(d, file(u))).then(() => true, () => false);
    expect(await there(MEDIA, old)).toBe(true);
    expect(await there(path.join(cwd, "public", "uploads"), old)).toBe(false);
    // 他人の写真は C からも見えないまま
    expect(await m.media.canViewDmMedia(C, file(theirs))).toBe(false);
  });

  it("グループ: いまのメンバーだけ見られる（外された人は見られない）", async () => {
    const g = await m.gdm.createGroup(a, "写真の会", [b.userId, c.userId]);
    const [p] = await upload(A);
    const sent = await m.gdm.sendGroupMessage(a, g.id, "", null, [p]);
    expect(sent.images).toEqual([p]);
    expect(sent.body).toBe("");
    expect(await m.media.canViewDmMedia(C, file(p))).toBe(true);
    await m.gdm.removeMember(a, g.id, c.userId);
    expect(await m.media.canViewDmMedia(C, file(p))).toBe(false);
    expect(await m.media.canViewDmMedia(B, file(p))).toBe(true);
    // 途中から入った人は、入る前の発言の写真を見られない（発言と同じ決まり）
    await m.gdm.addMembers(a, g.id, [c.userId]);
    expect(await m.media.canViewDmMedia(C, file(p))).toBe(false);
    const [p2] = await upload(A);
    await m.gdm.sendGroupMessage(a, g.id, "入ってから", null, [p2]);
    expect(await m.media.canViewDmMedia(C, file(p2))).toBe(true);
    // 他人の写真はグループにも付けられない
    const [theirs] = await upload(C);
    await expect(m.gdm.sendGroupMessage(b, g.id, "x", null, [theirs])).rejects.toMatchObject({ status: 400 });
  });

  it("送られなかった写真は 1 日、送った写真は期限＋1 日で消える（ファイルも）", async () => {
    {
      const [unsent, sentOld, sentNew] = await upload(A, 3);
      await m.api.dmSendApi(a, b.userId, { body: "新しい", images: [sentNew] });
      await m.api.dmSendApi(a, b.userId, { body: "古い", images: [sentOld] });
      await sql(`UPDATE dm_uploads SET created_at = now() - interval '2 days' WHERE name = ANY($1)`, [[file(unsent), file(sentNew)]]);
      await sql(`UPDATE dm_uploads SET created_at = now() - interval '32 days' WHERE name = $1`, [file(sentOld)]);
      await m.media.purgeDmMedia("30 days");
      const exists = async (u: string) => stat(path.join(MEDIA, file(u))).then(() => true, () => false);
      expect(await exists(unsent)).toBe(false);
      expect(await exists(sentOld)).toBe(false);
      expect(await exists(sentNew)).toBe(true);
      expect(await m.media.canViewDmMedia(A, file(unsent))).toBe(false);
    }
  });
});
