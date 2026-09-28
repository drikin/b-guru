import { describe, it, expect } from "vitest";
import {
  MAX_READ_BATCH,
  normalizeReadId,
  normalizeReadIds,
  mergeReadState,
  chunkReadIds,
  buildReadPayload,
} from "../read-state";

/**
 * 既読状態の純ロジック。
 *
 * ★ このテストは「実装より先に」書かれた。既読機能はサーバー永続化の前に
 *   ユニットテストが 1 件も無く（`grep -rn 'readStore|markReadId' src/lib/__tests__/`
 *   が 0 件）、移行のデグレを検出する網が存在しなかった。
 */

describe("normalizeReadId", () => {
  it("正の整数はそのまま通す", () => {
    expect(normalizeReadId(1)).toBe(1);
    expect(normalizeReadId(5647)).toBe(5647);
  });

  it("★ 非整数を弾く（PostgreSQL の int キャストで丸められるのを防ぐ）", () => {
    // `$2::int[]` に 1.5 を渡すと 1 に丸められる。サーバー側で弾かないと
    // 意図しない ID が保存される。
    expect(normalizeReadId(1.5)).toBeNull();
    expect(normalizeReadId(0.1)).toBeNull();
    expect(normalizeReadId(-2.5)).toBeNull();
  });

  it("0 と負数を弾く", () => {
    expect(normalizeReadId(0)).toBeNull();
    expect(normalizeReadId(-1)).toBeNull();
  });

  it("数値でないものを弾く", () => {
    expect(normalizeReadId("1")).toBeNull();
    expect(normalizeReadId(null)).toBeNull();
    expect(normalizeReadId(undefined)).toBeNull();
    expect(normalizeReadId({})).toBeNull();
    expect(normalizeReadId([])).toBeNull();
    expect(normalizeReadId(true)).toBeNull();
  });

  it("NaN / Infinity を弾く", () => {
    expect(normalizeReadId(NaN)).toBeNull();
    expect(normalizeReadId(Infinity)).toBeNull();
    expect(normalizeReadId(-Infinity)).toBeNull();
  });

  it("安全でない整数を弾く", () => {
    expect(normalizeReadId(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it("★ int32 の上限を超える値を弾く（PostgreSQL の 22003 を防ぐ）", () => {
    // 実測（2026-09-28・本番ログ）: `value "1786692568957" is out of range for
    // type integer` が 269 件（[posts/read] 119 / reactions 132）。
    // 渡っていた値はすべて 13 桁 = ミリ秒タイムスタンプ（楽観投稿の tempId）。
    //
    // `Number.isSafeInteger` は 2^53 まで通すので 13 桁を弾けない。
    // PostgreSQL の integer は int32（最大 2147483647）なので、
    // ここで上限を締めないと `$2::int[]` で必ず 22003 になる。
    expect(normalizeReadId(2147483647)).toBe(2147483647); // int32 の最大値は通す
    expect(normalizeReadId(2147483648)).toBeNull(); // 上限 +1 は弾く
    expect(normalizeReadId(1786692568957)).toBeNull(); // 実測で観測された 13 桁
    expect(normalizeReadId(Date.now())).toBeNull(); // tempId = Date.now() は必ず弾かれる
  });
});

describe("normalizeReadIds", () => {
  it("妥当なものだけを残す", () => {
    expect(normalizeReadIds([1, "a", null, -1, 1.5, 2])).toEqual([1, 2]);
  });

  it("重複を除去し、順序を保つ", () => {
    expect(normalizeReadIds([3, 1, 3, 2, 1])).toEqual([3, 1, 2]);
  });

  it("配列でなければ空を返す", () => {
    expect(normalizeReadIds(null)).toEqual([]);
    expect(normalizeReadIds("1,2")).toEqual([]);
    expect(normalizeReadIds({ 0: 1 })).toEqual([]);
  });

  it("空配列は空を返す", () => {
    expect(normalizeReadIds([])).toEqual([]);
  });
});

describe("mergeReadState — 移行の要", () => {
  it("サーバーが空なら、ローカルを全件送る", () => {
    const { merged, toPost } = mergeReadState([1, 2, 3], []);
    expect(toPost).toEqual([1, 2, 3]);
    expect([...merged].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("ローカルが空なら、何も送らない（サーバーが真実の源）", () => {
    const { merged, toPost } = mergeReadState([], [1, 2, 3]);
    expect(toPost).toEqual([]);
    expect([...merged].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it("重複は送らない（差分だけ送る）", () => {
    const { merged, toPost } = mergeReadState([1, 2, 3, 4], [1, 2]);
    expect(toPost).toEqual([3, 4]);
    expect([...merged].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it("完全一致なら何も送らない", () => {
    const { toPost } = mergeReadState([1, 2, 3], [1, 2, 3]);
    expect(toPost).toEqual([]);
  });

  it("★ 不変条件: merged は local と server の両方を含む（既読は減らない）", () => {
    const local = [1, 2, 3, 4, 5];
    const server = [4, 5, 6, 7];
    const { merged } = mergeReadState(local, server);
    for (const id of local) expect(merged.has(id)).toBe(true);
    for (const id of server) expect(merged.has(id)).toBe(true);
  });

  it("★ 逆順（サーバーでローカルを上書き）を検出する", () => {
    // 正しい実装は和集合。もし「サーバーの既読でローカルを置き換える」実装に
    // なっていたら、ローカルにしか無い 1,2,3 が消える。
    const { merged } = mergeReadState([1, 2, 3], [4, 5]);
    expect(merged.has(1)).toBe(true);
    expect(merged.has(2)).toBe(true);
    expect(merged.has(3)).toBe(true);
    expect(merged.has(4)).toBe(true);
    expect(merged.has(5)).toBe(true);
  });

  it("不正な値を無視する", () => {
    const { merged, toPost } = mergeReadState(
      [1, "a", null, -1, 1.5, 2] as unknown as number[],
      [2, NaN, 0] as unknown as number[]
    );
    expect(toPost).toEqual([1]);
    expect([...merged].sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it("Set を渡しても動く", () => {
    const { toPost } = mergeReadState(new Set([1, 2]), new Set([2]));
    expect(toPost).toEqual([1]);
  });

  it("大量でも正しく動く（実測: 1ユーザー最大 1,576 件）", () => {
    const local = Array.from({ length: 1576 }, (_, i) => i + 1);
    const server = Array.from({ length: 1000 }, (_, i) => i + 1);
    const { merged, toPost } = mergeReadState(local, server);
    expect(toPost).toEqual(Array.from({ length: 576 }, (_, i) => i + 1001));
    expect(merged.size).toBe(1576);
  });
});

describe("chunkReadIds", () => {
  it("上限で分割する", () => {
    const ids = Array.from({ length: 1200 }, (_, i) => i + 1);
    const chunks = chunkReadIds(ids, 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 200]);
  });

  it("上限以下なら1つ", () => {
    expect(chunkReadIds([1, 2, 3], 500)).toEqual([[1, 2, 3]]);
  });

  it("空なら空", () => {
    expect(chunkReadIds([], 500)).toEqual([]);
  });

  it("★ 1リクエストが MAX_READ_BATCH を超えない（DoS 防止）", () => {
    const ids = Array.from({ length: 5000 }, (_, i) => i + 1);
    for (const c of chunkReadIds(ids)) {
      expect(c.length).toBeLessThanOrEqual(MAX_READ_BATCH);
    }
  });
});

describe("buildReadPayload", () => {
  it("妥当な ID だけを載せる", () => {
    expect(buildReadPayload([1, "a", 2] as unknown as number[])).toEqual({ ids: [1, 2] });
  });

  it("空なら null（無駄な往復をしない）", () => {
    expect(buildReadPayload([])).toBeNull();
    expect(buildReadPayload(["a"] as unknown as number[])).toBeNull();
  });

  it("★ 上限を超えない", () => {
    const ids = Array.from({ length: 2000 }, (_, i) => i + 1);
    const p = buildReadPayload(ids);
    expect(p).not.toBeNull();
    expect(p!.ids.length).toBeLessThanOrEqual(MAX_READ_BATCH);
  });
});
