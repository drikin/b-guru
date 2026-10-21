/* 🎮 テスト用の自動操作（minigame-planner.ts の先読みの計画を今の sim で動かす）。
 * lapse（‰）を指定すると、その確率で判断を誤り、押す時刻も少しぶれる（短い・いろいろな記録を作る）。 */
import * as S from "../minigame/sim";
import { planRun, HUMAN, SKILLED, type BotOpts } from "./minigame-planner";

export function botRun(seed: number, character: string, opts: { lapse?: number; rngSeed?: number; maxTicks?: number } = {}) {
  const lapse = opts.lapse ?? 0;
  return planRun(S, seed, character, { err: lapse / 1000, jitter: lapse > 0 ? 2 : 0, rngSeed: opts.rngSeed, maxTicks: opts.maxTicks });
}

export function humanRun(seed: number, character: string, kind: "human" | "skilled", rngSeed: number, extra: BotOpts = {}) {
  return planRun(S, seed, character, { ...(kind === "human" ? HUMAN : SKILLED), rngSeed, ...extra });
}
