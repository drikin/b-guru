import { describe, expect, it } from "vitest";
import { fitView, VIEW_H, VIEW_W_MIN, VIEW_W_MAX } from "@/lib/minigame/render";

// 🎮 散財ダッシュの大きさ: 枠の横幅いっぱいに広げる（整数倍に限ると Mac のパネルで 144px にしかならなかった）。
describe("fitView", () => {
  it("Mac のパネル（幅 380・高さの上限 250）: 横幅いっぱい、論理の幅は 256", () => {
    const f = fitView(380, 250, 2);
    expect(f.w).toBe(VIEW_W_MIN);
    expect(f.cssW).toBe(380);
    expect(f.cssH).toBeGreaterThan(200);
    expect(f.cssH).toBeLessThanOrEqual(250);
  });

  it("高さの上限が低いと論理の幅を広げて収める（見える範囲が先へ伸びる）", () => {
    const f = fitView(393, 150, 3);
    expect(f.cssH).toBeLessThanOrEqual(150);
    expect(f.w).toBeGreaterThan(VIEW_W_MIN);
    expect(f.w).toBeLessThanOrEqual(VIEW_W_MAX);
  });

  it("広すぎる枠は上限の高さで止め、中央に置く幅になる", () => {
    const f = fitView(2000, 300, 2);
    expect(f.w).toBe(VIEW_W_MAX);
    expect(f.cssH).toBe(300);
    expect(f.cssW).toBeLessThan(2000);
  });

  it("論理の幅は 256 より狭くしない（先の見通しを減らさない）", () => {
    for (const [w, h] of [[300, 1000], [393, 600], [120, 400]] as const) {
      expect(fitView(w, h, 2).w).toBeGreaterThanOrEqual(VIEW_W_MIN);
    }
    expect(VIEW_H).toBe(144);
  });
});
