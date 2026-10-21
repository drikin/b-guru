/**
 * 🎮 決定論: ゲームの計算を Node（V8）で回した結果と、ブラウザ（playwright の chromium と webkit）で
 * public/minigame/game.js を回した結果が、同じ種・同じ操作で一致する（webkit は iOS/Mac の JavaScriptCore に近い）。
 * 刻み 60 ごとの状態の要約（digest）と最後の結果を比べる。ブラウザが入っていなければ飛ばす
 * （npx playwright install chromium webkit）。
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ENGINE_VERSION, traceRun } from "../minigame/sim";
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
      expect(got.v).toBe(ENGINE_VERSION);
      for (let i = 0; i < cases.length; i++) {
        expect(got.traces[i], `${name} case ${i}`).toEqual(nodeTraces[i]);
      }
      // 長い記録も含まれている（最後の区間まで走る）
      expect(Math.max(...nodeTraces.map((t) => t.result.ticks))).toBeGreaterThan(60 * 100);
    }, 60_000);
  });
}

// ごく短いタップ（pointerdown と pointerup が同じ瞬間）でも跳ぶ。記録には押しと離しが別の刻みで残る。
for (const bname of ["chromium", "webkit"] as const) {
  const browserType = pw?.[bname];
  let installed = false;
  try {
    installed = !!browserType && existsSync(browserType.executablePath());
  } catch {
    installed = false;
  }
  (installed ? describe : describe.skip)(`ごく短いタップ（${bname}）`, () => {
    it("押して離すのが同じ瞬間でもジャンプし、記録は押し→次の刻みで離し", async () => {
      const browser = await browserType!.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 393, height: 400 } });
        await page.setContent('<!doctype html><html><body><div id="minigame"></div></body></html>');
        // アプリの代わり: 発行の頼みにその場で答える
        await page.evaluate(() => {
          window.addEventListener("bguru-minigame", (e: Event) => {
            const m = (e as CustomEvent).detail as { type: string; req?: number; mode?: string; character?: string };
            const g = (window as unknown as { bguruMinigame: { receive: (x: unknown) => void } }).bguruMinigame;
            if (m.type === "request_play")
              setTimeout(() => g.receive({ type: "state", play: { req: m.req, play_id: 1, seed: 4242, mode: m.mode, character: m.character, engine_version: 2, date: null, expires_at: "" } }), 0);
          });
        });
        await page.addScriptTag({ content: js });
        await page.click('button[data-act="start"][data-arg="free"]');
        await page.waitForTimeout(500);
        const st = () =>
          page.evaluate(() => (window as unknown as { bguruMinigame: { game: { debugState: () => { phase: string; h: number; inputs: number[]; tick: number } } } }).bguruMinigame.game.debugState());
        expect((await st()).phase).toBe("playing");
        // 同じ瞬間に押して離す（1ms のタップ）
        await page.evaluate(() => {
          const el = document.querySelector(".mg-stage") as HTMLElement;
          const r = el.getBoundingClientRect();
          const o = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, pointerId: 1, pointerType: "touch", isPrimary: true, button: 0 };
          el.dispatchEvent(new PointerEvent("pointerdown", o));
          window.dispatchEvent(new PointerEvent("pointerup", o));
        });
        let maxH = 0;
        for (let i = 0; i < 20; i++) {
          await page.waitForTimeout(16);
          maxH = Math.max(maxH, (await st()).h);
        }
        expect(maxH).toBeGreaterThan(0);
        const ins = (await st()).inputs;
        expect(ins.length).toBe(2);
        expect(ins[0] & 3).toBe(1);
        expect(ins[1]).toBe(1 * 4 + 0); // 次の刻みで離す
      } finally {
        await browser.close();
      }
    }, 60_000);
  });
}
