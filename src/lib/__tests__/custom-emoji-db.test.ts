/**
 * カスタム絵文字の登録・削除（lib/custom-emoji.ts、オーナー 2026-10-27「誰でもどこからでも絵文字を登録削除」）。
 * EMOJI_TEST_DATABASE_URL があるときだけ動く（使い捨ての DB）。画像は public/uploads に書いて消す。
 *  - 誰でも登録・削除できる（他の人が登録したものも）。消すとその絵文字のリアクションも消える
 *  - 誰が登録・削除したかが custom_emoji_log に残る
 *  - 名前・形式・大きさ・重複・回数の枠
 *  - アプリの POST /api/agent/emojis はアプリの鍵だけ（ここでは lib を直接）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import path from "path";
import { rm } from "fs/promises";

const URL_ = process.env.EMOJI_TEST_DATABASE_URL;
if (URL_) process.env.DATABASE_URL = URL_;
const d = URL_ ? describe : describe.skip;

let db: typeof import("../db");
let ce: typeof import("../custom-emoji");
const stamp = Date.now();
const A = `em-a-${stamp}@test.local`;
const B = `em-b-${stamp}@test.local`;
const written: string[] = [];
const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], "e.png", { type: "image/png" });

d("カスタム絵文字（DB）", () => {
  beforeAll(async () => {
    db = await import("../db");
    ce = await import("../custom-emoji");
    await db.pool.query(`CREATE TABLE IF NOT EXISTS drinews_articles (id SERIAL PRIMARY KEY, author_email TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '', body_md TEXT NOT NULL DEFAULT '', body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft', scheduled_at TIMESTAMPTZ, published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS drinews_comments (id SERIAL PRIMARY KEY, article_id INTEGER REFERENCES drinews_articles(id),
      author_email TEXT NOT NULL DEFAULT '', author_name TEXT, comment TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
    await db.initSchema();
  });
  beforeEach(() => ce._resetEmojiRateForTest());
  afterAll(async () => {
    await Promise.all(written.map((u) => rm(path.join(process.cwd(), "public", "uploads", path.basename(u)), { force: true })));
    await db?.pool.end();
  });

  it("誰でも登録・削除でき、リアクションも消え、記録が残る", async () => {
    const e = await ce.registerCustomEmoji(A, "neko_ok", png());
    written.push(e.imageUrl);
    expect(e.name).toBe("neko_ok");
    await db.pool.query(`INSERT INTO reactions (target_type, target_id, user_email, emoji) VALUES ('post', 1, $1, ':neko_ok:')`, [B]);
    // A が登録したものを B が消せる
    await ce.removeCustomEmoji(B, e.id);
    expect((await db.pool.query(`SELECT 1 FROM custom_emojis WHERE id = $1`, [e.id])).rowCount).toBe(0);
    expect((await db.pool.query(`SELECT 1 FROM reactions WHERE emoji = ':neko_ok:'`)).rowCount).toBe(0);
    const log = await db.pool.query(`SELECT action, emoji_name, by_email FROM custom_emoji_log WHERE emoji_name = 'neko_ok' ORDER BY id`);
    expect(log.rows).toEqual([
      { action: "create", emoji_name: "neko_ok", by_email: A },
      { action: "delete", emoji_name: "neko_ok", by_email: B },
    ]);
    await expect(ce.removeCustomEmoji(B, e.id)).rejects.toMatchObject({ status: 404 });
  });

  it("名前・形式・大きさ・重複・回数の枠", async () => {
    await expect(ce.registerCustomEmoji(A, "Bad Name", png())).rejects.toMatchObject({ status: 400, code: "invalid_name" });
    await expect(ce.registerCustomEmoji(A, "x", "notafile")).rejects.toMatchObject({ status: 400 });
    await expect(ce.registerCustomEmoji(A, "x", new File(["a"], "a.svg", { type: "image/svg+xml" }))).rejects.toMatchObject({ status: 400 });
    await expect(ce.registerCustomEmoji(A, "x", new File([new Uint8Array(300 * 1024)], "a.png", { type: "image/png" }))).rejects.toMatchObject({ code: "too_large" });
    const e = await ce.registerCustomEmoji(A, "dup_one", png());
    written.push(e.imageUrl);
    await expect(ce.registerCustomEmoji(B, "dup_one", png())).rejects.toMatchObject({ status: 409 });
    // 登録できなかった画像は uploads に残らない
    const { readdir } = await import("fs/promises");
    const left = (await readdir(path.join(process.cwd(), "public", "uploads"))).filter((n) => n.startsWith("emoji-") && !written.some((u) => u.endsWith(n)));
    expect(left).toEqual([]);
    ce._resetEmojiRateForTest();
    for (let i = 0; i < 20; i++) await expect(ce.removeCustomEmoji(B, 999999 + i)).rejects.toMatchObject({ status: 404 });
    await expect(ce.removeCustomEmoji(B, 1)).rejects.toMatchObject({ status: 429 });
  });
});
