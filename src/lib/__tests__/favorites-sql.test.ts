import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * お気に入り (user_favorite_authors) の SQL 形状テスト（DB モック）。
 * 実 DB 結合テストは favorites.test.ts（DATABASE_URL がある環境のみ実行）。
 * ここでは SQL の重要な性質 — 冪等性・email 正規化・自己お気に入り拒否・
 * email 非漏えい — をクエリ形状で検証する。
 */

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../user", () => ({
  ensureUserId: vi.fn(async (e: string) => "uid_" + e),
  emailToUserId: vi.fn(async (e: string) => "uid_" + e),
  userIdToEmail: vi.fn(async (id: string) => (id.startsWith("uid_") ? id.slice(4) + "@x" : null)),
}));

import { addFavorite, removeFavorite, isFavorite, getFavoriteEmails } from "../favorites";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("favorites SQL shape", () => {
  it("★ add は ON CONFLICT DO NOTHING で冪等", async () => {
    await addFavorite("a@b.c", "d@e.f");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("ON CONFLICT (viewer_email, author_email) DO NOTHING");
  });

  it("★ add は email を trim+lowercase で正規化する（posts.author_email 規約と一致）", async () => {
    await addFavorite("  A@B.C ", " D@E.F ");
    const params = query.mock.calls[0][1];
    expect(params[0]).toBe("a@b.c");
    expect(params[1]).toBe("d@e.f");
  });

  it("★ remove は DELETE（行を残さない = club_visibility と同じ縮約方針）", async () => {
    await removeFavorite("a@b.c", "d@e.f");
    const sql = String(query.mock.calls[0][0]);
    expect(sql.trim().startsWith("DELETE FROM user_favorite_authors")).toBe(true);
  });

  it("★ isFavorite は両キーで絞る", async () => {
    query.mockResolvedValueOnce({ rows: [{ "?column?": 1 }], rowCount: 1 });
    expect(await isFavorite("a@b.c", "d@e.f")).toBe(true);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("viewer_email = $1 AND author_email = $2");
  });

  it("★ getFavoriteEmails は viewer の行だけを返す", async () => {
    query.mockResolvedValueOnce({ rows: [{ author_email: "x@y.z" }], rowCount: 1 });
    const set = await getFavoriteEmails("a@b.c");
    expect(set.has("x@y.z")).toBe(true);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("WHERE viewer_email = $1");
  });
});
