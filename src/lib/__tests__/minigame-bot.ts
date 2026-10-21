/* 🎮 テスト用の自動操作（先読み）。本物の遊び方に近い長い記録を作る（決定論・検算・DB のテストで使う）。
 * 地面にいて、近くに障害物・請求書があるときだけ「押さない／押す長さ 1・6・12・20 刻み」を先 60 刻み試して、
 * 当たらないものを選ぶ。lapse（‰）の確率でわざと判断を飛ばす（短い記録を作る）。 */
import * as S from "../minigame/sim";

function trial(s0: S.SimState, hold: number, n: number): number {
  const s = structuredClone(s0);
  let bad = 0;
  for (let t = 0; t < n && !s.dead; t++) {
    if (t === 0 && hold > 0) S.simInput(s, 1);
    if (t === hold) S.simInput(s, 0);
    if (s.choosing) break;
    S.simStep(s);
    if (s.ev & (S.E_HIT | S.E_BILLHIT)) bad += 10;
  }
  return bad + (s.dead ? 100 : 0);
}

export function botRun(seed: number, character: string, opts: { lapse?: number; rngSeed?: number; maxTicks?: number } = {}) {
  const s = S.newSim(seed, character);
  const rec = new S.InputRecorder();
  const r = { r: opts.rngSeed ?? 7 };
  const lapse = opts.lapse ?? 0;
  const maxTicks = opts.maxTicks ?? S.MAX_TICKS;
  let release = -1;
  const inp = (c: number) => {
    rec.push(s.tick, c);
    S.simInput(s, c);
  };
  while (!s.dead && s.tick < maxTicks) {
    if (s.choosing) {
      inp(2 + (S.rnd(r) % s.options.length));
      continue;
    }
    if (release >= 0 && s.tick >= release) {
      inp(0);
      release = -1;
    }
    if (s.ground && release < 0) {
      const px = s.x >> 8;
      const near = s.objs.some((o) => o.live && o.k < S.K_SD && o.x - px < 160 && o.x + o.w > px - 8);
      if (near && trial(s, 0, 60) > 0 && S.rnd(r) % 1000 >= lapse) {
        let best = -1;
        let bv = trial(s, 0, 60);
        for (const h of [1, 6, 12, 20]) {
          const v = trial(s, h, 60);
          if (v < bv) {
            bv = v;
            best = h;
          }
        }
        if (best > 0) {
          inp(1);
          release = s.tick + best;
        }
      }
    }
    S.simStep(s);
  }
  return { sim: s, inputs: rec.packed };
}
