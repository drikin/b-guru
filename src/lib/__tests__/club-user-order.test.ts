/** 部活一覧の並び順の受け取り（純粋関数）。 */
import { describe, it, expect } from "vitest";
import { MAX_ORDER, normalizeOrder } from "../club-user-order";

describe("normalizeOrder", () => {
  it("配列でなければ null", () => {
    expect(normalizeOrder("apple")).toBeNull();
    expect(normalizeOrder(undefined)).toBeNull();
    expect(normalizeOrder({ 0: "apple" })).toBeNull();
  });
  it("形の正しいキーだけ、重複は最初の 1 回", () => {
    expect(normalizeOrder(["pet", " apple ", "pet", 3, "Bad Key", "__unset__", ""])).toEqual(["pet", "apple", "__unset__"]);
  });
  it("空はカタログ順に戻す合図", () => {
    expect(normalizeOrder([])).toEqual([]);
  });
  it("上限まで", () => {
    const many = Array.from({ length: MAX_ORDER + 20 }, (_, i) => `c${i}`);
    expect(normalizeOrder(many)).toHaveLength(MAX_ORDER);
  });
});
