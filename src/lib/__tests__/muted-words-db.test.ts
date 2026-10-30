/**
 * NG ワード（muted_words）を DB を通して確かめる。
 *
 * 本物の PostgreSQL が要る。MUTED_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55442:5432 postgres:16-alpine
 *       MUTED_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55442/postgres npx vitest run muted-words-db
 *
 *  - 言葉を含むほかの人の投稿・返信はタイムライン（Web・アプリの since・検索・スレッド・注目）に出ない
 *  - 自分の投稿は含んでいても出る
 *  - 大文字小文字・全角半角は区別しない
 *  - 隠れる投稿への返信・メンションの知らせは作らない、新着の push も送らない相手になる
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const URL_ = process.env.MUTED_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = {
  db: typeof import("../db");
  posts: typeof import("../posts");
  mw: typeof import("../muted-words");
  since: typeof import("../agent-posts-since");
  notif: typeof import("../notifications");
};
let m: Mods;
const stamp = Date.now();
const ME = `mw-me-${stamp}@test.local`;
const OTHER = `mw-other-${stamp}@test.local`;

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
async function post(email: string, text: string, parentId: number | null = null) {
  const r = await sql(`INSERT INTO posts (author_email, author_name, text, parent_id) VALUES ($1, 'x', $2, $3) RETURNING id`, [email, text, parentId]);
  return r.rows[0].id as number;
}

d("NG ワード（DB）", () => {
  let anchor = 0;
  beforeAll(async () => {
    m = {
      db: await import("../db"),
      posts: await import("../posts"),
      mw: await import("../muted-words"),
      since: await import("../agent-posts-since"),
      notif: await import("../notifications"),
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
    await sql(`DELETE FROM notifications WHERE user_email LIKE 'mw-%'`);
    await sql(`DELETE FROM posts WHERE author_email LIKE 'mw-%'`);
    await sql(`DELETE FROM muted_words WHERE email LIKE 'mw-%'`);
    anchor = await post(OTHER, "anchor");
    await sql(`UPDATE posts SET created_at = now() - interval '1 hour' WHERE id = $1`, [anchor]);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM notifications WHERE user_email LIKE 'mw-%'`);
    await sql(`DELETE FROM posts WHERE author_email LIKE 'mw-%'`);
    await sql(`DELETE FROM muted_words WHERE email LIKE 'mw-%'`);
    await m.db.pool.end();
  });

  async function views() {
    const words = await m.mw.getMutedWords(ME);
    const web = await m.posts.listPosts({ viewerEmail: ME, mutedWords: words, limit: 200 });
    const app = await m.since.listPostsSince({ email: ME } as never, anchor, 200, [], words);
    return { web, app: app.map((p) => p.id), words };
  }

  it("言葉を含むほかの人の投稿は出ない、自分の投稿と含まない投稿は出る（大文字小文字・全角半角を問わない）", async () => {
    await m.mw.setMutedWords(ME, ["ネタバレ", "iphone"]);
    const theirs = await post(OTHER, "今日の ﾈﾀﾊﾞﾚ です");
    const theirs2 = await post(OTHER, "ＩＰＨＯＮＥ 18 の話");
    const mine = await post(ME, "ネタバレ注意（自分の投稿）");
    const clean = await post(OTHER, "雑談");
    const { web, app } = await views();
    const webIds = web.map((p) => p.id);
    for (const ids of [webIds, app]) {
      expect(ids).toContain(mine);
      expect(ids).toContain(clean);
      expect(ids).not.toContain(theirs);
      expect(ids).not.toContain(theirs2);
    }
  });

  it("返信も隠れる（タイムラインの埋め込み・スレッドとも）、自分の返信は出る", async () => {
    await m.mw.setMutedWords(ME, ["ネタバレ"]);
    const root = await post(OTHER, "映画の話");
    const bad = await post(OTHER, "ネタバレすると…", root);
    const ok = await post(OTHER, "面白かった", root);
    const mine = await post(ME, "ネタバレやめて", root);
    const { web, words } = await views();
    const r = web.find((p) => p.id === root);
    expect(r?.replies?.map((x) => x.id)).toEqual([ok, mine]);
    const t = await m.posts.getPostThread(root, ME, words);
    expect(t.replies.map((x) => x.id)).toEqual([ok, mine]);
    // ほかの人には今までどおり全部
    const other = await m.posts.getPostThread(root, OTHER, await m.mw.getMutedWords(OTHER));
    expect(other.replies.map((x) => x.id)).toEqual([bad, ok, mine]);
  });

  it("検索にも出ない", async () => {
    await m.mw.setMutedWords(ME, ["ネタバレ"]);
    const bad = await post(OTHER, "映画 ネタバレ");
    const ok = await post(OTHER, "映画 感想");
    const res = await m.posts.listPosts({ viewerEmail: ME, search: "映画", mutedWords: await m.mw.getMutedWords(ME), limit: 50 });
    const ids = res.map((p) => p.id);
    expect(ids).toContain(ok);
    expect(ids).not.toContain(bad);
  });

  it("言葉の登録: そろえる・重複を落とす・上限", async () => {
    expect(m.mw.cleanMutedWords(["  ＡＢＣ ", "abc", "", "ﾈﾀ  ﾊﾞﾚ"])).toEqual(["abc", "ネタ バレ"]);
    expect(m.mw.cleanMutedWords("x")).toHaveProperty("error");
    expect(m.mw.cleanMutedWords([1])).toHaveProperty("error");
    expect(m.mw.cleanMutedWords(["あ".repeat(41)])).toHaveProperty("error");
    expect(m.mw.cleanMutedWords(Array.from({ length: 51 }, (_, i) => `w${i}`))).toHaveProperty("error");

    const put = await m.mw.setMutedWordsApi(ME, { words: ["ネタバレ", "ＡＢＣ"] });
    expect(put).toMatchObject({ status: 200, body: { words: ["ネタバレ", "abc"] } });
    expect((await m.mw.getMutedWordsApi(ME)).body).toMatchObject({ words: ["ネタバレ", "abc"], max: 50, maxLength: 40 });
    expect((await m.mw.setMutedWordsApi(ME, { words: ["abc"] })).body.words).toEqual(["abc"]);
    expect((await m.mw.setMutedWordsApi(ME, { words: [] })).body.words).toEqual([]);
    expect((await m.mw.setMutedWordsApi(ME, { words: "abc" })).status).toBe(400);
  });

  it("隠れる投稿への返信・メンションの知らせは作らない", async () => {
    await m.mw.setMutedWords(ME, ["ネタバレ"]);
    const myPost = await post(ME, "映画みた");
    const badReply = await post(OTHER, "ネタバレだけど", myPost);
    const okReply = await post(OTHER, "よかったね", myPost);
    const badRoot = await post(OTHER, "ネタバレスレ");
    const replyInBad = await post(OTHER, "@me どう？", badRoot);

    const n1 = await m.notif.createNotification({ userEmail: ME, type: "reply", actorEmail: OTHER, postId: myPost, replyId: badReply, text: "x" });
    const n2 = await m.notif.createNotification({ userEmail: ME, type: "reply", actorEmail: OTHER, postId: myPost, replyId: okReply, text: "y" });
    const n3 = await m.notif.createNotification({ userEmail: ME, type: "mention", actorEmail: OTHER, postId: replyInBad, replyId: null, text: "z" });
    expect(n1).toBeNull();
    expect(n2).not.toBeNull();
    expect(n3).toBeNull();
    const rows = await sql(`SELECT reply_id FROM notifications WHERE user_email = $1`, [ME]);
    expect(rows.rows.map((r) => r.reply_id)).toEqual([okReply]);

    // 新着の push: 隠れる人だけ外れる（投稿者は外れない扱いにしない）
    const muted = await m.mw.mutedRecipients(badRoot, [ME, OTHER]);
    expect([...muted]).toEqual([ME]);
    const mineBad = await post(ME, "ネタバレ（自分）");
    expect([...(await m.mw.mutedRecipients(mineBad, [ME]))]).toEqual([]);
  });
});
