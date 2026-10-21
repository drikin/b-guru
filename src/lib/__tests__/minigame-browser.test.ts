/**
 * 🎮 決定論: ゲームの計算を Node（V8）で回した結果と、ブラウザ（playwright の chromium と webkit）で
 * public/minigame/game.js を回した結果が、同じ種・同じ操作で一致する（webkit は iOS/Mac の JavaScriptCore に近い）。
 * 刻み 60 ごとの状態の要約（digest）と最後の結果を比べる。ブラウザが入っていなければ飛ばす
 * （npx playwright install chromium webkit）。
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { traceRun } from "../minigame/sim";
import { botRun } from "./minigame-bot";

type PW = typeof import("playwright");
let pw: PW | null = null;
try {
  pw = await import("playwright");
} catch {
  pw = null;
}

const cases = [
  { seed: 20261021, ch: "drikin", ...botRun(20261021, "drikin") },
  { seed: 1234567, ch: "matsuo", ...botRun(1234567, "matsuo", { lapse: 120, rngSeed: 4 }) },
  { seed: 99, ch: "zenji", ...botRun(99, "zenji", { lapse: 60, rngSeed: 8 }) },
  { seed: 2147483000, ch: "drikin", ...botRun(2147483000, "drikin", { lapse: 400, rngSeed: 2 }) },
].map((c) => ({ seed: c.seed, ch: c.ch, inputs: c.inputs }));

const nodeTraces = cases.map((c) => traceRun(c.seed, c.ch, c.inputs));
const js = readFileSync(path.join(process.cwd(), "public/minigame/game.js"), "utf8");

for (const name of ["chromium", "webkit"] as const) {
  const browserType = pw?.[name];
  let installed = false;
  try {
    installed = !!browserType && existsSync(browserType.executablePath());
  } catch {
    installed = false;
  }
  const d = installed ? describe : describe.skip;
  d(`決定論（Node と ${name}）`, () => {
    let browser: import("playwright").Browser | null = null;
    afterAll(async () => {
      await browser?.close();
    });
    it("同じ種・同じ操作で、刻みごとの要約と結果が Node と一致する", async () => {
      browser = await browserType!.launch();
      const page = await browser.newPage();
      await page.setContent("<!doctype html><html><body></body></html>");
      await page.addScriptTag({ content: js });
      const got = await page.evaluate((cs) => {
        const eng = (window as unknown as { bguruMinigameEngine: { traceRun: (s: number, c: string, i: number[]) => unknown; engine_version: number } })
          .bguruMinigameEngine;
        return { v: eng.engine_version, traces: cs.map((c) => eng.traceRun(c.seed, c.ch, c.inputs)) };
      }, cases);
      expect(got.v).toBe(1);
      for (let i = 0; i < cases.length; i++) {
        expect(got.traces[i], `${name} case ${i}`).toEqual(nodeTraces[i]);
      }
      // 長い記録も含まれている（3 分ほど走る）
      expect(Math.max(...nodeTraces.map((t) => t.result.ticks))).toBeGreaterThan(60 * 150);
    }, 60_000);
  });
}
