/**
 * 部活一覧の並び順（club_user_order）と部活ごとの未読数を DB を通して確かめる。
 *
 * 本物の PostgreSQL が要る。CLUB_VIS_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB を指すこと。
 * 書き方は club-visibility-db.test.ts と同じ）。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

const URL_ = process.env.CLUB_VIS_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

type Mods = { db: typeof import("../db"); order: typeof import("../club-user-order"); words: typeof import("../muted-words") };
let m: Mods;
const stamp = Date.now();
const ME = `cuo-me-${stamp}@test.local`;
const OTHER = `cuo-other-${stamp}@test.local`;

async function sql(q: string, params: unknown[] = []) {
  return m.db.pool.query(q, params);
}
async function post(email: string, text: string, club: string | null, parent: number | null = null) {
  const r = await sql(`INSERT INTO posts (author_email, author_name, text, club, parent_id) VALUES ($1, 'x', $2, $3, $4) RETURNING id`, [email, text, club, parent]);
  return r.rows[0].id as number;
}

d("部活一覧の並び順と未読数（DB）", () => {
  beforeAll(async () => {
    m = { db: await import("../db"), order: await import("../club-user-order"), words: await import("../muted-words") };
    await sql(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await m.db.initSchema();
  });

  beforeEach(async () => {
    await sql(`DELETE FROM posts WHERE author_email LIKE 'cuo-%'`);
    await sql(`DELETE FROM club_user_order WHERE email LIKE 'cuo-%'`);
    await sql(`DELETE FROM muted_words WHERE email LIKE 'cuo-%'`);
  });

  afterAll(async () => {
    if (!m) return;
    await sql(`DELETE FROM posts WHERE author_email LIKE 'cuo-%'`);
    await sql(`DELETE FROM club_user_order WHERE email LIKE 'cuo-%'`);
    await sql(`DELETE FROM muted_words WHERE email LIKE 'cuo-%'`);
    await m.db.pool.end();
  });

  it("並び順は置き換え・読み出し・空で消える、人ごと", async () => {
    expect(await m.order.getClubOrder(ME)).toEqual([]);
    await m.order.setClubOrder(ME, ["pet", "apple", "car"]);
    await m.order.setClubOrder(OTHER, ["car"]);
    expect(await m.order.getClubOrder(ME)).toEqual(["pet", "apple", "car"]);
    await m.order.setClubOrder(ME, ["apple", "pet"]);
    expect(await m.order.getClubOrder(ME)).toEqual(["apple", "pet"]);
    await m.order.setClubOrder(ME, []);
    expect(await m.order.getClubOrder(ME)).toEqual([]);
    expect(await m.order.getClubOrder(OTHER)).toEqual(["car"]);
  });

  it("未読数: ほかの人のまだ読んでいない投稿だけ（返信・自分・既読・古い・NG ワードは数えない）", async () => {
    const a1 = await post(OTHER, "新しい MacBook", "apple");
    await post(OTHER, "iPhone の話", "apple");
    const read = await post(OTHER, "読んだ投稿", "apple");
    await sql(`INSERT INTO post_read_state (email, post_id) VALUES ($1, $2)`, [ME, read]);
    await post(OTHER, "返信", "apple", a1);
    await post(ME, "自分の投稿", "apple");
    const old = await post(OTHER, "古い投稿", "apple");
    await sql(`UPDATE posts SET created_at = now() - interval '40 days' WHERE id = $1`, [old]);
    await post(OTHER, "うちの犬", "pet");
    await post(OTHER, "ネタバレ注意の猫", "pet");
    await post(OTHER, "未分類", null);
    await sql(`INSERT INTO muted_words (email, word) VALUES ($1, 'ネタバレ')`, [ME]);
    const n = await m.order.getClubUnreadCounts(ME);
    expect(n.apple).toBe(2);
    expect(n.pet).toBe(1);
    expect(n.__unset__).toBe(1);
  });
});
