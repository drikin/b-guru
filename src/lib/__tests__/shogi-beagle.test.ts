/**
 * ☗ ビーグルが考える道（lib/shogi-beagle-think.ts）と worker（lib/shogi-beagle-worker.generated.ts）。
 *  - 考える時間の上限（速い将棋・秒読み・ゆっくり）
 *  - worker（別スレッド）で探索し、その間メインのイベントループが止まらない
 *  - worker が無い（テスト環境）・落ちた・返事が来ないときもすぐ合法手を指す
 *  - 束ねた worker が探索のソースとずれていない
 */
import { describe, it, expect, afterAll } from "vitest";
import { INITIAL_SFEN, legalUsi } from "../shogi-rules";
import { beagleThink, searchInWorker, thinkBudgetMs, thinkDelayMs, _stopBeagleWorker } from "../shogi-beagle-think";
import { shouldResign } from "../shogi-beagle";
import { BEAGLE_WORKER_SOURCE_HASH } from "../shogi-beagle-worker.generated";
import { sourceHash } from "../../../scripts/build-shogi-beagle-worker.mjs";

const MID = "l2gk2nl/1r1s2g2/p1np1pspp/2p1p1p2/1p5P1/2PPP1P2/PPSG1P2P/2G1K2R1/LN6L b BNPbsp 1";
/** 持ち駒が多く、4 手読むと 1 秒以上かかる局面（時間の上限・返事の遅れを試す）。 */
const HEAVY = "4k4/9/9/9/9/9/9/9/4K4 b RBGSNLPrbgsnlp 1";

afterAll(async () => {
  await _stopBeagleWorker();
});

describe("考える時間の上限", () => {
  it("速い将棋: 持ち時間が多ければ 2.5 秒、少なければ短く、秒読みは 5 秒以内", () => {
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: null, byoyomiLeftMs: null })).toBe(1500);
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: 600_000, byoyomiLeftMs: null })).toBe(2500);
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: 30_000, byoyomiLeftMs: null })).toBe(1000);
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: 3_000, byoyomiLeftMs: null })).toBe(300);
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: 0, byoyomiLeftMs: 30_000 })).toBe(5000);
    expect(thinkBudgetMs({ mode: "blitz", mainLeftMs: 0, byoyomiLeftMs: 8_000 })).toBe(2000);
    expect(thinkBudgetMs({ mode: "slow", mainLeftMs: null, byoyomiLeftMs: null })).toBe(3000);
  });
  it("考えている間は 0.8〜2 秒、上限は超えない", () => {
    expect(thinkDelayMs(5000, () => 0)).toBe(800);
    expect(thinkDelayMs(5000, () => 0.999)).toBe(1998);
    expect(thinkDelayMs(300, () => 0.5)).toBe(300);
  });
});

describe("worker", () => {
  it("束ねた worker が探索のソースと一致する（ずれたら node scripts/build-shogi-beagle-worker.mjs）", () => {
    expect(BEAGLE_WORKER_SOURCE_HASH).toBe(sourceHash());
  });

  it("別スレッドで探索し、その間もイベントループは止まらない", async () => {
    let ticks = 0;
    let maxGap = 0;
    let last = Date.now();
    const iv = setInterval(() => {
      const now = Date.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 10);
    // 静止探索を深くして、上限いっぱい考えさせる
    const r = await searchInWorker(HEAVY, { timeMs: 700, maxDepth: 4, qMax: 12 }, 3000);
    clearInterval(iv);
    expect(legalUsi(HEAVY)).toContain(r.usi);
    expect(r.ms).toBeGreaterThanOrEqual(650);
    expect(r.ms).toBeLessThan(700 + 150);
    expect(ticks).toBeGreaterThan(20);
    expect(maxGap).toBeLessThan(120);
  });

  it("worker で考えた手は tsshogi で合法", async () => {
    process.env.SHOGI_BEAGLE_WORKER = "1";
    try {
      const t = await beagleThink(INITIAL_SFEN, 300);
      expect(t.source).toBe("worker");
      expect(legalUsi(INITIAL_SFEN)).toContain(t.usi);
    } finally {
      delete process.env.SHOGI_BEAGLE_WORKER;
    }
  });

  it("返事が来なければ worker を捨てて reject（呼び出し側はすぐ指せる手に切り替える）", async () => {
    await expect(searchInWorker(HEAVY, { timeMs: 5000, maxDepth: 4, qMax: 12 }, 50)).rejects.toThrow(/timeout/);
    // 次は作り直して動く
    const r = await searchInWorker(INITIAL_SFEN, { timeMs: 100, maxDepth: 1 }, 3000);
    expect(r.usi).toBeTruthy();
  });
});

describe("worker が無くても指せる", () => {
  it("worker の返事が来なければ、すぐ指せる手（1 手読み＋取り合い）を tsshogi で確かめて指す", async () => {
    const t0 = Date.now();
    const t = await beagleThink(HEAVY, 5000, { inline: false, workerTimeoutMs: 30 });
    expect(t.source).toBe("fallback");
    expect(legalUsi(HEAVY)).toContain(t.usi);
    expect(Date.now() - t0).toBeLessThan(600);
  });
  it("テスト環境はその場で探索（inline）", async () => {
    const t = await beagleThink(MID, 200);
    expect(t.source).toBe("inline");
    expect(legalUsi(MID)).toContain(t.usi);
  });
  it("合法手がなければ null", async () => {
    // 先手玉 9i が詰んでいる局面（後手の金 9h・と 8h…）: 合法手なし
    const mated = "8k/9/9/9/9/9/9/gg7/K8 b - 1";
    expect(legalUsi(mated)).toEqual([]);
    const t = await beagleThink(mated, 200);
    expect(t.usi).toBeNull();
  });
});

describe("投了", () => {
  const base = { usi: "7g7f", source: "inline" as const };
  const res = (score: number, material: number) => ({ ...base, result: { usi: "7g7f", score, material, depth: 3, nodes: 1, mateIn1: false, timedOut: false, ms: 1, legalCount: 1 } });
  it("詰みを読まれ駒も大損、または駒の損が非常に大きいときだけ（序盤はしない）", () => {
    expect(shouldResign(res(-99990, -1500), 60)).toBe(true);
    expect(shouldResign(res(-99990, 200), 60)).toBe(false);
    expect(shouldResign(res(-3000, -3500), 60)).toBe(true);
    expect(shouldResign(res(-99990, -1500), 10)).toBe(false);
  });
});
