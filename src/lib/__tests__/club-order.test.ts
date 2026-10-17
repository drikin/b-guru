import { describe, it, expect } from "vitest";
import { orderClubKeys } from "../club-order";

describe("orderClubKeys（部活の表示順）", () => {
  const catalog = ["a", "b", "c", "d"];
  const activity = { a: 1, b: 9, c: 5, d: 0 };

  it("ピン無しは活性度降順、同数はカタログ順", () => {
    expect(orderClubKeys(catalog, activity)).toEqual(["b", "c", "a", "d"]);
    expect(orderClubKeys(catalog, {})).toEqual(catalog);
  });

  it("ピンは活性度に関係なくピンした順で先頭に固定", () => {
    expect(orderClubKeys(catalog, activity, ["d", "a"])).toEqual(["d", "a", "b", "c"]);
  });

  it("カタログに無い（削除・非アクティブ化された）ピンと重複は無視", () => {
    expect(orderClubKeys(catalog, activity, ["gone", "c", "c"])).toEqual(["c", "b", "a", "d"]);
  });

  it("入力配列を書き換えない", () => {
    const keys = [...catalog];
    orderClubKeys(keys, activity, ["d"]);
    expect(keys).toEqual(catalog);
  });
});
