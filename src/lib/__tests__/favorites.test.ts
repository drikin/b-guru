import { describe, it, expect, afterAll } from "vitest";
import {
  addFavorite,
  removeFavorite,
  isFavorite,
  getFavoriteEmails,
  listFavoriteIds,
} from "../favorites";
import { pool } from "../db";
import { ensureUserId } from "../user";

/**
 * お気に入り (user_favorite_authors) の単体テスト。
 * DB 結合テスト: DATABASE_URL が無い環境ではスキップ
 * （既存 read-state-server.test.ts と同じガードパターン）。
 */
const hasDb = !!process.env.DATABASE_URL;
const d = hasDb ? it : it.skip;

// テスト用の一意な viewer/author（他テスト・本番データと衝突しない）
const viewer = `fav-test-viewer-${Date.now()}@test.local`;
const authorA = `fav-test-a-${Date.now()}@test.local`;
const authorB = `fav-test-b-${Date.now()}@test.local`;

afterAll(async () => {
  if (!hasDb) return;
  await pool.query(`DELETE FROM user_favorite_authors WHERE viewer_email LIKE 'fav-test-%'`);
});

describe("favorites lib", () => {
  d("add is idempotent and isFavorite reflects it", async () => {
    await addFavorite(viewer, authorA);
    await addFavorite(viewer, authorA); // 2回目は no-op
    expect(await isFavorite(viewer, authorA)).toBe(true);
  });

  d("remove is idempotent", async () => {
    await removeFavorite(viewer, authorA);
    await removeFavorite(viewer, authorA);
    expect(await isFavorite(viewer, authorA)).toBe(false);
  });

  d("getFavoriteEmails returns only this viewer's set", async () => {
    await addFavorite(viewer, authorA);
    await addFavorite(viewer, authorB);
    const set = await getFavoriteEmails(viewer);
    expect(set.has(authorA)).toBe(true);
    expect(set.has(authorB)).toBe(true);
    const other = await getFavoriteEmails(authorA);
    expect(other.has(authorA)).toBe(false);
  });

  d("emails are normalized (trim + lowercase)", async () => {
    await addFavorite(`  ${viewer.toUpperCase()}  `, authorA);
    expect(await isFavorite(viewer, authorA)).toBe(true);
  });

  d("listFavoriteIds resolves user_ids and never leaks emails", async () => {
    // users テーブルにマッピングを作って user_id が解決されることを確認
    const aId = await ensureUserId(authorA);
    const ids = await listFavoriteIds(viewer);
    expect(ids).toContain(aId);
    // user_id は 12 文字の opaque id（email を含まない）
    for (const id of ids) {
      expect(id).not.toContain("@");
    }
  });

  d("self-favorite is impossible by CHECK constraint", async () => {
    await expect(addFavorite(authorA, authorA)).rejects.toThrow();
  });
});
