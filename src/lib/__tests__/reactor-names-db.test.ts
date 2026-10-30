/**
 * リアクションの「付けた人」の名前（lib/reactions.ts、ドリキン 2026-10-30「ID じゃなくてプロフィール名に」）。
 * REACTOR_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB）。
 *  - プロフィール名があればそれ
 *  - なければ最後に投稿したときの名前（ほかの画面と同じ）。メールの @ より前（ID）にはしない
 *  - どちらもなければ @ より前
 *  - チャットのリアクション（live で配る分）も同じ
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const URL_ = process.env.REACTOR_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

const emitted: unknown[] = [];
vi.mock("../live", async (orig) => ({ ...(await orig<object>()), emitLive: (e: unknown) => emitted.push(e) }));

let db: typeof import("../db");
let rx: typeof import("../reactions");
const stamp = Date.now();
const PROFILE = `rn-p-${stamp}@test.local`;
const POSTER = `rn-q-${stamp}@test.local`;
const NOBODY = `rn-n-${stamp}@test.local`;

d("リアクションの名前（DB）", () => {
  beforeAll(async () => {
    db = await import("../db");
    rx = await import("../reactions");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
    await db.pool.query(`INSERT INTO user_profiles (email, display_name) VALUES ($1, 'プロフ名')`, [PROFILE]);
    // 古い名前と新しい名前: 新しいほうを使う
    await db.pool.query(
      `INSERT INTO posts (author_email, author_name, text, created_at) VALUES ($1, '昔の名前', 'a', now() - interval '1 day'), ($1, '投稿の名前', 'b', now())`,
      [POSTER]
    );
    for (const [i, em] of [PROFILE, POSTER, NOBODY].entries()) {
      await db.pool.query(
        `INSERT INTO reactions (target_type, target_id, user_email, emoji, created_at) VALUES ('post', 987654, $1, '👍', now() + $2 * interval '1 second'),
                                                                                          ('chat', 987654, $1, '👍', now() + $2 * interval '1 second')`,
        [em, i]
      );
    }
  });
  afterAll(async () => {
    await db?.pool.query(`DELETE FROM reactions WHERE target_id = 987654`);
    await db?.pool.end();
  });

  it("プロフィール名 → 最後の投稿の名前 → @ より前", async () => {
    const m = await rx.getReactions("post", [987654], null);
    expect(m.get(987654)?.[0].reactors).toEqual(["プロフ名", "投稿の名前", `rn-n-${stamp}`]);
  });

  it("チャットのリアクション（live）も同じ名前", async () => {
    await rx.broadcastChatReactions(987654);
    const e = emitted.at(-1) as { reactions: { reactors: string[] }[] };
    expect(e.reactions[0].reactors).toEqual(["プロフ名", "投稿の名前", `rn-n-${stamp}`]);
  });
});
