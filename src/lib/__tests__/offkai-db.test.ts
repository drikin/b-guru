/**
 * 🍻 オフ会の DB を通した確認（lib/offkai.ts・lib/offkai-api.ts、docs/offkai-spec.md）。
 *
 * 本物の PostgreSQL が要る。OFFKAI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55433:5432 postgres:16-alpine
 *       OFFKAI_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run src/lib/__tests__/offkai-db.test.ts
 * LiveKit・push は設定なし（声の鍵は 503、push は送らない）。写真は public/uploads に書いて消す。
 *
 *  - 始める: 誰でも・同時に 1 つ（409 busy と開催中の会）。チャットに小さな行
 *  - 話す: 後勝ち（版が進む）、話していない人の「やめる」は何も変えない
 *  - 終える: 始めた人・話す人・管理者だけ。後処理は 1 回（チャットの行・写真があればタイムライン投稿）
 *  - 6 時間で自動で終わる（ended_at は ends_at）、アーカイブに並ぶ
 *  - 写真: offkai-… に保存して EXIF を落とす、チャットにも chat-… の複製、消せるのは本人だけ（原本も消える）
 *  - 応答・知らせにメールが載らない
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import path from "path";
import sharp from "sharp";

const URL_ = process.env.OFFKAI_TEST_DATABASE_URL;
process.env.OFFKAI_ENABLED = "1";
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  o: typeof import("../offkai");
  api: typeof import("../offkai-api");
  live: typeof import("../live");
  user: typeof import("../user");
};
let m: Mods;
const stamp = Date.now();
const A = `ok-a-${stamp}@test.local`;
const B = `ok-b-${stamp}@test.local`;
const C = `ok-c-${stamp}@test.local`;
type Actor = { email: string; userId: string };
let a: Actor;
let b: Actor;
let c: Actor;
const live: { type: string; action?: string }[] = [];
const written: string[] = [];

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}

function req(method: string, url: string, body?: unknown): Request {
  return new Request(`http://x/api/offkai${url}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });
}

async function call(actor: Actor, method: string, p: string[], body?: unknown, query = "") {
  return m.api.handleOffkai(req(method, `/${p.join("/")}${query}`, body), p, actor);
}

/** 小さな JPEG（EXIF 付き）を multipart で。 */
async function photoReq(caption: string, n = 1): Promise<Request> {
  const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Copyright: "secret-exif", Artist: "someone" } })
    .toBuffer();
  const form = new FormData();
  for (let i = 0; i < n; i++) form.append("images", new File([new Uint8Array(jpeg)], `p${i}.jpg`, { type: "image/jpeg" }));
  form.append("caption", caption);
  const r = new Response(form);
  const buf = await r.arrayBuffer();
  return new Request("http://x/api/offkai/photos", {
    method: "POST",
    body: buf,
    headers: { "Content-Type": r.headers.get("Content-Type")!, "Content-Length": String(buf.byteLength) },
  });
}

const file = (url: string) => path.join(process.cwd(), "public", "uploads", path.basename(url));

d("🍻 オフ会（DB）", () => {
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      o: await import("../offkai"),
      api: await import("../offkai-api"),
      live: await import("../live"),
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
    await sql(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'ねこ'), ($2, 'みけ'), ($3, 'たま') ON CONFLICT DO NOTHING`, [A, B, C]);
    m.live.liveBus.on("change", (ev: { type: string }) => live.push(ev));
  });

  beforeEach(async () => {
    m.o._resetOffkaiForTest();
    await sql(`UPDATE offkai_events SET ended_at = now(), finalized_at = now() WHERE ended_at IS NULL`);
    live.length = 0;
  });

  afterAll(async () => {
    m?.o._resetOffkaiForTest();
    const { rm } = await import("fs/promises");
    await Promise.all(written.map((u) => rm(file(u), { force: true })));
  });

  it("始める: 同時に 1 つ（409 busy と開催中の会）、状態とチャットの行、メールは出ない", async () => {
    const r = await call(a, "POST", [], { title: "渋谷" });
    expect(r.status).toBe(201);
    const ev = (r.body as { event: { id: number; title: string; started_by: { name: string; user_id: string }; can_end: boolean; ends_at: string; started_at: string } }).event;
    expect(ev).toMatchObject({ title: "渋谷", started_by: { name: "ねこ", user_id: a.userId }, can_end: true });
    expect(new Date(ev.ends_at).getTime() - new Date(ev.started_at).getTime()).toBe(6 * 60 * 60 * 1000);

    const busy = await call(b, "POST", [], { title: "別" });
    expect(busy.status).toBe(409);
    expect(busy.body).toMatchObject({ code: "busy", current: { id: ev.id } });

    const st = await call(b, "GET", []);
    expect(st.body).toMatchObject({ enabled: true, can: { start: false, speak: true, upload: true }, current: { id: ev.id, can_end: false } });

    const notice = await sql(`SELECT body FROM chat_messages WHERE kind = 'notice' ORDER BY id DESC LIMIT 1`);
    expect(notice.rows[0].body).toBe("🍻 ねこさんがオフ会を始めました（渋谷）。🍻 から聞けます");
    expect(JSON.stringify([r.body, busy.body, st.body, live])).not.toContain("@test.local");
    expect(live.some((e) => e.type === "offkai" && e.action === "start")).toBe(true);
  });

  it("話す: 後勝ち、話していない人の「やめる」は変えない。終えるのは始めた人・話す人だけ", async () => {
    const r = await call(a, "POST", [], { title: "" });
    const id = (r.body as { event: { id: number } }).event.id;
    const s1 = await call(b, "POST", ["speak"], { on: true });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ event: { speaker: { user_id: b.userId, name: "みけ", connected: false } } });
    const v1 = (s1.body as { event: { version: number } }).event.version;

    const s2 = await call(c, "POST", ["speak"], { on: true });
    expect(s2.body).toMatchObject({ event: { speaker: { user_id: c.userId } } });
    expect((s2.body as { event: { version: number } }).event.version).toBeGreaterThan(v1);

    const s3 = await call(b, "POST", ["speak"], { on: false });
    expect(s3.body).toMatchObject({ event: { speaker: { user_id: c.userId } } });

    // b は始めた人でも話す人でもない → 終えられない。話す人 c は終えられる。
    const no = await call(b, "POST", ["end"]);
    expect(no.status).toBe(403);
    const yes = await call(c, "POST", ["end"]);
    expect(yes.status).toBe(200);
    expect(yes.body).toMatchObject({ event: { id, speaker: null } });
    expect((yes.body as { event: { ended_at: string | null } }).event.ended_at).not.toBeNull();
    // 写真がなければタイムライン投稿はしない。終わりの行は出る。後処理は済んでいる。
    const row = await sql(`SELECT summary_post_id, finalized_at, ended_by_email FROM offkai_events WHERE id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ summary_post_id: null, ended_by_email: C });
    expect(row.rows[0].finalized_at).not.toBeNull();
    const notice = await sql(`SELECT body FROM chat_messages WHERE kind = 'notice' ORDER BY id DESC LIMIT 1`);
    expect(notice.rows[0].body).toBe("🍻 オフ会が終わりました（写真 0 枚）。🍻 のアーカイブから見返せます");
    // もう 1 度終えても何も起きない
    expect((await call(a, "POST", ["end"])).status).toBe(409);
    expect((await call(a, "POST", ["speak"], { on: true })).status).toBe(409);
  });

  it("6 時間で自動で終わる（ended_at は ends_at）、アーカイブに並び、新しく始められる", async () => {
    const r = await call(a, "POST", [], { title: "自動" });
    const id = (r.body as { event: { id: number } }).event.id;
    await sql(`UPDATE offkai_events SET started_at = now() - interval '7 hours', ends_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    const st = await call(b, "GET", []);
    const body = st.body as { current: unknown; archive: { id: number; ended_at: string; ends_at: string }[]; can: { start: boolean } };
    expect(body.current).toBeNull();
    expect(body.can.start).toBe(true);
    const arch = body.archive.find((e) => e.id === id)!;
    expect(arch.ended_at).toBe(arch.ends_at);
    expect((await call(b, "POST", [], { title: "次" })).status).toBe(201);
  });

  it("写真: offkai-… に EXIF なしで保存、チャットにも複製、消せるのは本人だけ。終わるとタイムラインに 1 本", async () => {
    const r = await call(a, "POST", [], { title: "上野" });
    const id = (r.body as { event: { id: number } }).event.id;

    const up = await m.api.handleOffkai(await photoReq("かんぱい", 2), ["photos"], b);
    expect(up.status).toBe(201);
    const photos = (up.body as { photos: { id: number; url: string; caption: string; mine: boolean; uploader: { name: string } }[] }).photos;
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({ caption: "かんぱい", mine: true, uploader: { name: "みけ" } });
    for (const p of photos) {
      expect(p.url).toMatch(/^\/api\/media\/offkai-\d+-[0-9a-f]+\.jpe?g$/);
      written.push(p.url);
      const meta = await sharp(await readFile(file(p.url))).metadata();
      expect(meta.exif).toBeUndefined();
    }
    // チャットにも chat-… の複製で 1 件
    const chat = await sql(`SELECT body, images FROM chat_messages WHERE author_email = $1 ORDER BY id DESC LIMIT 1`, [B]);
    expect(chat.rows[0].body).toBe("🍻 かんぱい");
    expect(chat.rows[0].images).toHaveLength(2);
    for (const u of chat.rows[0].images as string[]) {
      expect(u).toMatch(/^\/api\/media\/chat-/);
      written.push(u);
      expect(existsSync(file(u))).toBe(true);
    }

    const list = await call(c, "GET", [String(id), "photos"]);
    expect((list.body as { photos: { id: number; mine: boolean }[] }).photos.map((p) => [p.id, p.mine])).toEqual(photos.map((p) => [p.id, false]));
    expect(JSON.stringify([up.body, list.body, live])).not.toContain("@test.local");

    // 他人は消せない、本人は消せる（原本も消える）
    expect((await call(c, "DELETE", ["photos", String(photos[0].id)])).status).toBe(403);
    expect((await call(b, "DELETE", ["photos", String(photos[0].id)])).status).toBe(200);
    expect(existsSync(file(photos[0].url))).toBe(false);

    // 終わる → 残った 1 枚でタイムライン投稿
    await call(a, "POST", ["end"]);
    const row = await sql(`SELECT summary_post_id FROM offkai_events WHERE id = $1`, [id]);
    const postId = row.rows[0].summary_post_id;
    expect(postId).not.toBeNull();
    const post = await sql(`SELECT text FROM posts WHERE id = $1`, [postId]);
    expect(post.rows[0].text).toContain("上野オフ会のアルバム（写真 1 枚）");
    const imgs = await sql(`SELECT url FROM post_images WHERE post_id = $1`, [postId]);
    expect(imgs.rows.map((x) => x.url)).toEqual([photos[1].url]);
    // 終わったあとのアルバムも見られる。終わった会には上げられない。
    expect(((await call(c, "GET", [String(id), "photos"])).body as { photos: unknown[] }).photos).toHaveLength(1);
    const late = await m.api.handleOffkai(await photoReq("おそい"), ["photos"], b);
    expect(late.status).toBe(409);
    // 断った写真のファイルは残らない
    const dir = await import("fs/promises").then((f) => f.readdir(path.join(process.cwd(), "public", "uploads")));
    const leftovers = dir.filter((n) => n.startsWith("offkai-") && !written.some((u) => u.endsWith(n)));
    expect(leftovers).toEqual([]);
  });

  it("道順: 知らない道は 404、おかしな id は 404、声の鍵は LiveKit なしで 503", async () => {
    expect((await call(a, "GET", ["nope"])).status).toBe(404);
    expect((await call(a, "GET", ["0"])).status).toBe(404);
    expect((await call(a, "GET", ["999999999"])).status).toBe(404);
    await call(a, "POST", [], { title: "鍵" });
    const t = await call(a, "POST", ["token"]);
    expect(t.status).toBe(503);
    expect(t.body).toMatchObject({ code: "voice_unavailable" });
  });
});
