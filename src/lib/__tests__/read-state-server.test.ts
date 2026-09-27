import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 既読のサーバー永続化。
 *
 * ★ 最重要の検証: `WHERE EXISTS` が無いと FK 違反でバッチ全体がアボートし、
 *   生きている ID も失われる。本番 DB で実証済み:
 *     ON CONFLICT DO NOTHING だけ → ERROR: violates foreign key constraint
 *     WHERE EXISTS を挟む        → INSERT 0 1
 */

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { markPostsRead, getReadPostIds, getReadIdsForPosts } from "../read-state-server";
import { MAX_READ_BATCH } from "../read-state";

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe("markPostsRead", () => {
  it("★ WHERE EXISTS を必ず含む（FK 違反でバッチ全体が消えるのを防ぐ）", async () => {
    await markPostsRead("a@b.c", [1, 2, 3]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain("WHERE EXISTS");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
  });

  it("unnest で1回のクエリにまとめる（件数分の往復をしない）", async () => {
    await markPostsRead("a@b.c", [1, 2, 3, 4, 5]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("unnest");
  });

  it("email はセッション由来の値をそのまま使う（他人の既読を書けない）", async () => {
    await markPostsRead("me@example.com", [1]);
    expect(query.mock.calls[0][1][0]).toBe("me@example.com");
  });

  it("不正な ID を落としてから渡す", async () => {
    await markPostsRead("a@b.c", [1, "x", null, -1, 1.5, 2] as unknown as number[]);
    expect(query.mock.calls[0][1][1]).toEqual([1, 2]);
  });

  it("★ 上限を超える配列を切り詰める（DoS 防止）", async () => {
    const ids = Array.from({ length: 5000 }, (_, i) => i + 1);
    await markPostsRead("a@b.c", ids);
    expect((query.mock.calls[0][1][1] as number[]).length).toBe(MAX_READ_BATCH);
  });

  it("空配列ならクエリを発行しない", async () => {
    const n = await markPostsRead("a@b.c", []);
    expect(n).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("email が無ければ何もしない", async () => {
    const n = await markPostsRead("", [1]);
    expect(n).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("挿入行数を返す", async () => {
    query.mockResolvedValue({ rows: [], rowCount: 3 });
    expect(await markPostsRead("a@b.c", [1, 2, 3])).toBe(3);
  });
});

describe("getReadPostIds", () => {
  it("post_id の配列を返す", async () => {
    query.mockResolvedValue({ rows: [{ post_id: 1 }, { post_id: 2 }] });
    expect(await getReadPostIds("a@b.c")).toEqual([1, 2]);
  });

  it("★ 剪定しない（LIMIT を付けない）", async () => {
    // jump-to-post は最大 4,000 ルートまで遡るので、保持件数を切ると
    // 古い投稿が未読として復活する。
    await getReadPostIds("a@b.c");
    const sql = String(query.mock.calls[0][0]);
    expect(sql).not.toMatch(/LIMIT/i);
  });

  it("email が無ければ空", async () => {
    expect(await getReadPostIds("")).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("getReadIdsForPosts", () => {
  it("指定した投稿のうち既読のものだけ返す", async () => {
    query.mockResolvedValue({ rows: [{ post_id: 2 }] });
    expect(await getReadIdsForPosts("a@b.c", [1, 2, 3])).toEqual([2]);
  });

  it("ANY で1回のクエリにまとめる", async () => {
    await getReadIdsForPosts("a@b.c", [1, 2, 3]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(String(query.mock.calls[0][0])).toContain("ANY");
  });

  it("空配列ならクエリを発行しない", async () => {
    expect(await getReadIdsForPosts("a@b.c", [])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it("email が無ければ空", async () => {
    expect(await getReadIdsForPosts("", [1])).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});
