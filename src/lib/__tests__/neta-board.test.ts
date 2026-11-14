/**
 * 📝 ネタ帳の公開ページの読み出し（lib/neta-board.ts）。
 * 小物はそのまま、DB を使う部分は DM_TEST_DATABASE_URL があるときだけ（使い捨ての DB を指すこと）。
 *   例: docker run --rm -e POSTGRES_PASSWORD=x -p 127.0.0.1:55434:5432 postgres:16-alpine
 *       DM_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55434/postgres npx vitest run neta-board --exclude '.claude/**'
 */
import { describe, it, expect, beforeAll } from "vitest";

const URL_ = process.env.DM_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

describe("📝 ネタ帳の小物", async () => {
  const m = await import("../neta-board");

  it("リンクにしてよいのは http(s) だけ", () => {
    expect(m.netaSafeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(m.netaSafeHref("javascript:alert(1)")).toBeNull();
    expect(m.netaSafeHref("data:text/html,x")).toBeNull();
    expect(m.netaSafeHref("not a url")).toBeNull();
  });

  it("サイト名は www. を外したホスト", () => {
    expect(m.netaHost("https://www.itmedia.co.jp/news/x")).toBe("itmedia.co.jp");
    expect(m.netaHost("ftp://x.example")).toBe("");
  });

  it("説明の冒頭は空白をまとめて切る", () => {
    expect(m.netaPreview("  a\n\n b  ")).toBe("a b");
    expect(m.netaPreview("あ".repeat(200), 10)).toBe("あ".repeat(10) + "…");
    expect(m.netaPreview(null)).toBe("");
  });

  it("時刻は日本時間", () => {
    expect(m.netaDate("2026-11-08T19:40:00Z")).toBe("2026/11/09 04:40");
    expect(m.netaDate("bad")).toBe("");
  });

  it("ライブ収録日は読みやすく、知らない形はそのまま", () => {
    expect(m.netaLiveDate("2026-09-13T13:00")).toBe("2026/09/13 13:00");
    expect(m.netaLiveDate("2026-09-13")).toBe("2026/09/13");
    expect(m.netaLiveDate("TBD")).toBe("TBD");
  });

  it("並べ方は new 以外は聞きたい順", () => {
    expect(m.netaSort("new")).toBe("new");
    expect(m.netaSort(["new", "stars"])).toBe("new");
    expect(m.netaSort("x")).toBe("stars");
    expect(m.netaSort(undefined)).toBe("stars");
  });
});

d("📝 ネタ帳の読み出し（DB）", () => {
  let m: typeof import("../neta-board");
  let db: typeof import("../db");
  const base = 900000 + (Date.now() % 50000);

  beforeAll(async () => {
    db = await import("../db");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
    m = await import("../neta-board");
    await db.pool.query(`UPDATE neta_weeks SET is_active = false WHERE is_active`);
    await db.pool.query(
      `INSERT INTO neta_weeks (id, title, start_date, end_date, is_active) VALUES ($1, 'ep1', '2026-11-01', '2026-11-08', false), ($2, 'ep2', '2026-11-08', '2026-11-15', true)`,
      [base, base + 1]
    );
    await db.pool.query(
      `INSERT INTO neta_topics (id, week_id, title, url, submitter, status, legacy_stars, created_at) VALUES
       ($1, $4, '古い票が多い', 'https://a.example/1', 'ねこ', 'pending', 5, now() - interval '2 hours'),
       ($2, $4, '新しい票で並ぶ', 'https://a.example/2', 'みけ', 'featured', 3, now() - interval '1 hour'),
       ($3, $4, '票なし', 'https://a.example/3', 'たま', 'pending', 0, now())`,
      [base, base + 1, base + 2, base + 1]
    );
    await db.pool.query(`INSERT INTO neta_votes (topic_id, voter) VALUES ($1,'m:1'), ($1,'m:2'), ($1,'b:did:x')`, [base + 1]);
    await db.pool.query(`INSERT INTO neta_comments (topic_id, commenter, body) VALUES ($1, 'ねこ', '聞きたい！')`, [base]);
  });

  it("今週は印のついた週", async () => {
    expect((await m.getCurrentWeek())?.id).toBe(base + 1);
  });

  it("聞きたい = 昔の票 + 新しい票で並び、同数は新しい順", async () => {
    const list = await m.listTopics(base + 1, "stars");
    expect(list.map((t) => [t.id, t.stars])).toEqual([[base + 1, 6], [base, 5], [base + 2, 0]]);
    expect(list[0].featured).toBe(true);
    expect(list.find((t) => t.id === base)?.comments).toBe(1);
  });

  it("新しい順", async () => {
    expect((await m.listTopics(base + 1, "new")).map((t) => t.id)).toEqual([base + 2, base + 1, base]);
  });

  it("1 つのネタはコメントと週つき、ない id は null", async () => {
    const got = await m.getTopic(base);
    expect(got?.week?.title).toBe("ep2");
    expect(got?.comments.map((c) => c.body)).toEqual(["聞きたい！"]);
    expect(await m.getTopic(-1)).toBeNull();
    expect(await m.getTopic(base + 999)).toBeNull();
    expect(await m.getWeek(0)).toBeNull();
  });
});
