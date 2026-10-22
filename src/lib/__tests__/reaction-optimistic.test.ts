/** リアクションを押した直後の楽観表示（lib/reaction-optimistic.ts・Web の投稿とチャットで共通）。 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { toggleReactionOptimistic } from "../reaction-optimistic";

const r = (emoji: string, count: number, mine: boolean, reactors: string[]) => ({ emoji, count, mine, reactors });

describe("toggleReactionOptimistic", () => {
  it("★ 他人だけが付けた絵文字を押すと、自分が足される（数が減らない・他人の名前が消えない）", () => {
    const out = toggleReactionOptimistic([r("❤️", 2, false, ["mazzo", "riyu"])], "❤️", "どりきん");
    expect(out).toEqual([r("❤️", 3, true, ["mazzo", "riyu", "どりきん"])]);
  });

  it("自分も付けている絵文字を押すと、自分だけ外れる", () => {
    const out = toggleReactionOptimistic([r("❤️", 3, true, ["mazzo", "どりきん", "riyu"])], "❤️", "どりきん");
    expect(out).toEqual([r("❤️", 2, false, ["mazzo", "riyu"])]);
  });

  it("自分だけが付けていた絵文字を外すと、チップごと消える", () => {
    expect(toggleReactionOptimistic([r("👍", 1, true, ["どりきん"]), r("❤️", 1, false, ["mazzo"])], "👍", "どりきん")).toEqual([
      r("❤️", 1, false, ["mazzo"]),
    ]);
  });

  it("まだ無い絵文字は自分 1 人で足す", () => {
    expect(toggleReactionOptimistic([], "🎉", "どりきん")).toEqual([r("🎉", 1, true, ["どりきん"])]);
  });

  it("名前は 12 人まで（数は増える）", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `会員${i}`);
    const out = toggleReactionOptimistic([r("❤️", 14, false, twelve)], "❤️", "どりきん");
    expect(out[0]).toEqual(r("❤️", 15, true, twelve));
  });

  it("名前の一覧に自分が見当たらなくても（12 人で切られている）数だけ減らす", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `会員${i}`);
    const out = toggleReactionOptimistic([r("❤️", 14, true, twelve)], "❤️", "どりきん");
    expect(out[0]).toEqual(r("❤️", 13, false, twelve));
  });

  it("Web の投稿とチャットの両方がこの関数を使う", () => {
    const page = fs.readFileSync(path.join(__dirname, "..", "..", "app", "page.tsx"), "utf8");
    expect(page.match(/toggleReactionOptimistic\(current, emoji, myReactorName\)/g)).toHaveLength(2);
    expect(page).not.toMatch(/reactors: r\.reactors\.slice\(1\)/);
  });
});
