import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * ブックマーク (user_post_bookmarks) の SQL 形状テスト（DB モック）。
 * お気に入り favorites-sql.test.ts と同型。実 DB 結合は DATABASE_URL がある環境で。
 */

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { addBookmark, removeBookmark, isBookmarked, getBookmarkedPostIds } from "../bookmarks";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("bookmarks SQL shape", () => {
  it("★ add は ON CONFLICT (viewer_email, post_id) DO NOTHING で冪等", async () => {
    await addBookmark("a@b.c", 42);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("ON CONFLICT (viewer_email, post_id) DO NOTHING");
    expect(sql).toContain("INSERT INTO user_post_bookmarks");
  });

  it("★ add は email を trim+lowercase 正規化（favorites と同一規約）", async () => {
    await addBookmark("  A@B.C ", 42);
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe("a@b.c");
    expect(params[1]).toBe(42);
  });

  it("★ remove は DELETE（行を残さない）", async () => {
    await removeBookmark("a@b.c", 42);
    const sql = String(query.mock.calls[0][0]);
    expect(sql.trim().startsWith("DELETE FROM user_post_bookmarks")).toBe(true);
  });

  it("★ getBookmarkedPostIds は viewer で絞り created_at DESC", async () => {
    query.mockResolvedValueOnce({ rows: [{ post_id: 7 }, { post_id: 3 }], rowCount: 2 });
    const ids = await getBookmarkedPostIds("a@b.c");
    expect(ids).toEqual([7, 3]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("WHERE viewer_email = $1");
    expect(sql).toContain("ORDER BY created_at DESC");
  });

  it("★ isBookmarked は両キーで絞る", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
    expect(await isBookmarked("a@b.c", 42)).toBe(true);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("viewer_email = $1 AND post_id = $2");
  });
});
