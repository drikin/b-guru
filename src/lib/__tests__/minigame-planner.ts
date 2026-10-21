/* 🎮 テスト用の自動操作（先読みの計画）。sim のモジュールを引数でもらう（import しない。旧版の sim とも比べられる）。
 *
 * 地面にいて、何もしないと当たりそうなときだけ計画を立てる: 「いつ押すか（今〜20 刻み先）× 押す長さ × 空中のタップ」
 * を先 70 刻み試し、当たらない計画のうち、押す時刻の「当たらない幅」の真ん中を選ぶ（人がねらう所）。
 * 人に近くするための項目:
 *   delay   見えてから（プレイヤーの 300px 先に入ってから）気づくまでの刻み [min, max]。気づくまでは無いものとして計画する
 *   jitter  押す時刻のぶれ（± 刻み）、holdErr 押す長さのぶれ（割合）、err 判断ミスの確率（別の計画を選ぶ）
 * delay 0・jitter 0・err 0 なら「完璧な人」（理不尽な配置がないかの検査に使う）。 */
import type * as SimT from "../minigame/sim";

type S = typeof SimT;
type St = SimT.SimState;

export type BotOpts = {
  delay?: [number, number];
  jitter?: number;
  holdErr?: number;
  err?: number;
  rngSeed?: number;
  maxTicks?: number;
  horizon?: number;
};

type Plan = { off: number; hold: number; taps: number[] };

const HOLDS = [1, 6, 12, 20];
const TAPSETS: number[][] = [[], [8], [14], [20], [6, 11], [12, 17]];
const VIEW = 300;

function rnd01(r: { r: number }, S: S): number {
  return (S.rnd(r) % 100000) / 100000;
}

/** 計画を試す（当たり・落下の数 ×10、終わりなら +100）。horizon を過ぎても着地するまでは見る。
 *  aware = 気づいている物（index）。first = 最初に当たった刻み。 */
function trial(S: S, s0: St, plan: Plan | null, horizon: number, aware: boolean[] | null, limit = 1e9): { bad: number; first: number } {
  const s = structuredClone(s0);
  if (aware) s.objs = s.objs.filter((_, i) => aware[i]);
  let bad = 0;
  let first = -1;
  const fall = (S as unknown as { E_FALL?: number }).E_FALL ?? 0;
  const last = plan ? plan.off + plan.hold + (plan.taps.at(-1) ?? 0) + 2 : 0;
  for (let t = 0; t < horizon + 90 && !s.dead; t++) {
    if (t >= horizon && t > last && s.ground) break;
    if (plan) {
      if (t === plan.off) S.simInput(s, 1);
      if (t === plan.off + plan.hold) S.simInput(s, 0);
      for (const a of plan.taps) {
        if (t === plan.off + plan.hold + a) S.simInput(s, 1);
        if (t === plan.off + plan.hold + a + 1) S.simInput(s, 0);
      }
    }
    if (s.choosing) break;
    S.simStep(s);
    if (s.ev & (S.E_HIT | S.E_BILLHIT | fall) && t <= limit) {
      bad += 10;
      if (first < 0) first = t;
    }
    if (t > limit && s.ground) break;
  }
  return { bad: bad + (s.dead && t0Dead(s) ? 100 : 0), first: first < 0 && s.dead ? 0 : first };
}

function t0Dead(s: St): boolean {
  return !!s.dead && s.cause !== "deadline";
}

export function planRun(S: S, seed: number, character: string, opts: BotOpts = {}, init?: (s: St) => void) {
  const s = S.newSim(seed, character);
  if (init) init(s);
  const rec = new S.InputRecorder();
  const r = { r: (opts.rngSeed ?? 7) | 0 };
  const [dmin, dmax] = opts.delay ?? [0, 0];
  const jitter = opts.jitter ?? 0;
  const holdErr = opts.holdErr ?? 0;
  const err = opts.err ?? 0;
  const horizon = opts.horizon ?? 70;
  const maxTicks = opts.maxTicks ?? S.MAX_TICKS;
  const seen = new Map<SimT.Obj, number>();
  const delayOf = new Map<SimT.Obj, number>();
  // 予定（絶対の刻み → code の並び）
  const sched = new Map<number, number[]>();
  let busyUntil = -1;
  const inp = (c: number) => {
    rec.push(s.tick, c);
    S.simInput(s, c);
  };
  const at = (t: number, c: number) => {
    const l = sched.get(t) ?? [];
    l.push(c);
    sched.set(t, l);
  };
  while (!s.dead && s.tick < maxTicks) {
    if (s.choosing) {
      inp(2 + (S.rnd(r) % s.options.length));
      continue;
    }
    const px = s.x >> 8;
    for (const o of s.objs) {
      if (!seen.has(o) && o.x - px < VIEW) {
        seen.set(o, s.tick);
        delayOf.set(o, dmin + (dmax > dmin ? S.rnd(r) % (dmax - dmin + 1) : 0));
      }
    }
    const now = sched.get(s.tick);
    if (now) {
      sched.delete(s.tick);
      for (const c of now) inp(c);
    }
    if (s.ground && s.tick >= busyUntil && sched.size === 0) {
      const aware = dmax > 0 ? s.objs.map((o) => s.tick - (seen.get(o) ?? s.tick) >= (delayOf.get(o) ?? 0)) : null;
      const baseT = trial(S, s, null, horizon, aware);
      const base = baseT.bad;
      if (base > 0) {
        // 押す時刻の候補: 最初に当たる刻みの 46 刻み前から、その刻みまで（2 刻みおき）
        const OFFSETS: number[] = [];
        for (let o = Math.max(0, baseT.first - 46); o <= Math.max(0, baseT.first); o += 2) OFFSETS.push(o);
        // 押す時刻ごとの当たらない計画 → 幅の真ん中
        let best: Plan | null = null;
        let bestScore = Infinity;
        let bestWidth = -1;
        const all: Plan[] = [];
        for (const hold of HOLDS)
          for (const taps of TAPSETS) {
            const safe: number[] = [];
            let minBad = Infinity;
            let minOff = 0;
            for (const off of OFFSETS) {
              const p = { off, hold, taps };
              // 次の 1 つ（最初に当たる物）を避けることだけを考える（人と同じく 1 つずつ）
              const v = trial(S, s, p, horizon, aware, baseT.first + 30).bad;
              all.push(p);
              if (v === 0) safe.push(off);
              if (v < minBad) {
                minBad = v;
                minOff = off;
              }
            }
            if (safe.length) {
              // いちばん長い連続（2 刻みおき）の真ん中
              let runStart = 0;
              let bestRun: [number, number] = [0, 0];
              for (let i = 1; i <= safe.length; i++) {
                if (i === safe.length || safe[i] !== safe[i - 1] + 2) {
                  if (i - runStart > bestRun[1] - bestRun[0]) bestRun = [runStart, i];
                  runStart = i;
                }
              }
              const width = bestRun[1] - bestRun[0];
              const mid = safe[(bestRun[0] + bestRun[1] - 1) >> 1];
              // 空中のタップ（急降下など）は、要るときだけ（幅がはっきり広いときだけ選ぶ。人は簡単な方を選ぶ）
              const w2 = taps.length ? width - 3 : width;
              if (w2 > bestWidth || (w2 === bestWidth && mid < (best?.off ?? 99))) {
                bestWidth = w2;
                best = { off: mid, hold, taps };
                bestScore = 0;
              }
            } else if (bestWidth < 0 && minBad < bestScore) {
              bestScore = minBad;
              best = { off: minOff, hold, taps };
            }
          }
        if (best && bestScore < base) {
          let p = best;
          // 判断ミス: 押す長さを取り違える（軽く↔長く）か、押す時刻を大きく外す
          if (err > 0 && rnd01(r, S) < err) {
            const wrong = all.filter((q) => q.taps.length === 0 && (q.hold !== p.hold || Math.abs(q.off - p.off) >= 8));
            if (wrong.length) p = wrong[S.rnd(r) % wrong.length];
          }
          let off = p.off;
          if (jitter > 0) off += (S.rnd(r) % (2 * jitter + 1)) - jitter;
          if (off < 0) off = 0;
          let hold = p.hold;
          if (holdErr > 0) hold = Math.max(1, Math.round(hold * (1 + (rnd01(r, S) * 2 - 1) * holdErr)));
          const t0 = s.tick + off;
          at(t0, 1);
          at(t0 + hold, 0);
          for (const a of p.taps) {
            let ta = t0 + hold + a;
            if (jitter > 0) ta += (S.rnd(r) % (2 * jitter + 1)) - jitter;
            if (ta <= t0 + hold) ta = t0 + hold + 1;
            at(ta, 1);
            at(ta + 1, 0);
          }
          busyUntil = t0 + 2;
          // 今の刻みの分はすぐ当てる
          const now2 = sched.get(s.tick);
          if (now2) {
            sched.delete(s.tick);
            for (const c of now2) inp(c);
          }
        }
      }
    }
    S.simStep(s);
  }
  return { sim: s, inputs: rec.packed };
}

/** 人に近い（ふつう）・上手の設定。 */
export const HUMAN: BotOpts = { delay: [9, 15], jitter: 3, holdErr: 0.25, err: 0.08 };
export const SKILLED: BotOpts = { delay: [6, 6], jitter: 1, holdErr: 0.1, err: 0 };
