/**
 * 部活の表示・非表示（club_visibility）を DB を通して確かめる。
 *
 * 本物の PostgreSQL が要る。CLUB_VIS_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55441:5432 postgres:16-alpine
 *       CLUB_VIS_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55441/postgres npx vitest run club-visibility-db
 *
 *  - 隠した部活のほかの人の投稿はタイムラインに出ない（Web の listPosts・アプリの since 取得とも）
 *  - 自分の投稿は、隠した部活に分類されても出る（2026-10-28 西田家の投稿が本人に見えなかった）
 *  - アプリの窓口 /api/agent/clubs/visibility で読む・切り替える
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const URL_ = process.env.CLUB_VIS_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  posts: typeof import("../posts");
  vis: typeof import("../club-visibility");
  since: typeof import("../agent-posts-since");
  api: typeof import("../club-visibility-api");
};
let m: Mods;
const stamp = Date.now();
const ME = `cv-me-${stamp}@test.local`;
const OTHER = `cv-other-${stamp}@test.local`;

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
async function post(email: string, text: string, club: string | null) {
  const r = await sql(`INSERT INTO posts (author_email, author_name, text, club) VALUES ($1, 'x', $2, $3) RETURNING id`, [email, text, club]);
  return r.rows[0].id as number;
}

d("部活の表示・非表示（DB）", () => {
  let anchor = 0;
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      posts: await import("../posts"),
      vis: await import("../club-visibility"),
      since: await import("../agent-posts-since"),
      api: await import("../club-visibility-api"),
    };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
  });

  beforeEach(async () => {
    await sql(`DELETE FROM posts WHERE author_email LIKE 'cv-%'`);
    await sql(`DELETE FROM club_visibility WHERE email LIKE 'cv-%'`);
    anchor = await post(OTHER, "anchor", null);
    await sql(`UPDATE posts SET created_at = now() - interval '1 hour' WHERE id = $1`, [anchor]);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM posts WHERE author_email LIKE 'cv-%'`);
    await sql(`DELETE FROM club_visibility WHERE email LIKE 'cv-%'`);
    await m.db.pool.end();
  });

  async function timelineIds() {
    const hidden = Array.from(await m.vis.getHiddenClubs(ME));
    const web = await m.posts.listPosts({ viewerEmail: ME, excludeClubs: hidden, limit: 200 });
    const app = await m.since.listPostsSince({ email: ME } as never, anchor, 200, hidden);
    return { web: web.map((p) => p.id), app: app.map((p) => p.id) };
  }

  it("隠した部活のほかの人の投稿は出ない、自分の投稿は出る", async () => {
    await m.vis.setClubHidden(ME, "apple", true);
    const mine = await post(ME, "西田カメラ", "apple");
    const theirs = await post(OTHER, "iPhone の話", "apple");
    const open = await post(OTHER, "雑談", "chat");
    const unset = await post(OTHER, "未分類", null);
    const { web, app } = await timelineIds();
    for (const ids of [web, app]) {
      expect(ids).toContain(mine);
      expect(ids).toContain(open);
      expect(ids).toContain(unset);
      expect(ids).not.toContain(theirs);
    }
    // since 取得は基準の投稿より新しいものだけ（基準そのもの・古いものは出ない）
    expect(app).not.toContain(anchor);
    expect(web).toContain(anchor);
  });

  it("何も隠していなければ全部出る", async () => {
    const mine = await post(ME, "a", "apple");
    const theirs = await post(OTHER, "b", "apple");
    const { web, app } = await timelineIds();
    for (const ids of [web, app]) expect(ids).toEqual(expect.arrayContaining([mine, theirs]));
  });

  it("アプリの窓口で読む・隠す・戻す", async () => {
    const ctx = { email: ME } as never;
    expect((await m.api.getVisibilityApi(ctx)).body).toEqual({ apiVersion: 1, hidden: [] });

    const put = await m.api.setVisibilityApi(ctx, { club: "__unset__", hidden: true });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ club: "__unset__", hidden: true });
    expect((await m.api.getVisibilityApi(ctx)).body.hidden).toEqual(["__unset__"]);

    expect((await m.api.setVisibilityApi(ctx, { club: "__unset__", hidden: false })).status).toBe(200);
    expect((await m.api.getVisibilityApi(ctx)).body.hidden).toEqual([]);
  });

  it("おかしな部活キーは 400", async () => {
    const ctx = { email: ME } as never;
    for (const club of ["", "  ", "Apple!", "x".repeat(41), 3]) {
      expect((await m.api.setVisibilityApi(ctx, { club, hidden: true })).status).toBe(400);
    }
    // ない部活は隠せない（戻すのはできる＝消えた部活の行も消せる）
    expect((await m.api.setVisibilityApi(ctx, { club: "no-such-club", hidden: true })).status).toBe(400);
    expect((await m.api.setVisibilityApi(ctx, { club: "no-such-club", hidden: false })).status).toBe(200);
  });
});
