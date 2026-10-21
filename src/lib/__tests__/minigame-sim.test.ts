/**
 * 🎮 締め切りダッシュのゲームの計算（lib/minigame/sim.ts）:
 *  - 決定性: 同じ種・同じ操作なら、何度でも・刻みごとに同じ。記録の再生（replay）とその場の遊び（simStep）が一致
 *  - 整数だけ: 状態の数はすべて整数。ソースに浮動小数点の関数・import がない
 *  - 記録の形（刻みの差 * 4 + code）、選んだパワーアップも記録に入る、壊れた記録・終わらない記録は ok:false
 *  - ルールの固定（ENGINE_VERSION 1 の答え合わせ。ルールを変えたら版を上げてここを更新する）
 *  - 手触り: 助走の 3 秒は障害物がない、うまい人は 3〜4 分で締め切りに追いつかれる、キャラの差
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as S from "../minigame/sim";
import { botRun } from "./minigame-bot";

function liveRun(seed: number, ch: string, packed: number[]) {
  const events = S.unpackInputs(packed)!;
  const s = S.newSim(seed, ch);
  let i = 0;
  while (!s.dead && s.tick < S.MAX_TICKS) {
    while (i < events.length && events[i].tick === s.tick) S.simInput(s, events[i++].code);
    if (s.choosing) {
      if (i < events.length && events[i].tick === s.tick) continue;
      break;
    }
    S.simStep(s);
  }
  return s;
}

function allIntegers(v: unknown, at = "s"): string | null {
  if (typeof v === "number") return Number.isInteger(v) ? null : at;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const bad = allIntegers(v[i], `${at}[${i}]`);
      if (bad) return bad;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      const bad = allIntegers(x, `${at}.${k}`);
      if (bad) return bad;
    }
  }
  return null;
}

describe("決定性", () => {
  const runs = [
    botRun(101, "drikin"),
    botRun(202, "matsuo", { lapse: 200, rngSeed: 3 }),
    botRun(303, "zenji", { lapse: 100, rngSeed: 5 }),
  ];

  it("同じ種・同じ操作なら replay は何度でも同じ、刻みごとの要約も同じ", () => {
    for (const [i, r] of runs.entries()) {
      const ch = ["drikin", "matsuo", "zenji"][i];
      const seed = [101, 202, 303][i];
      const a = S.traceRun(seed, ch, r.inputs);
      const b = S.traceRun(seed, ch, r.inputs);
      expect(a).toEqual(b);
      const rp = S.replay(seed, ch, r.inputs);
      expect(rp.ok).toBe(true);
      expect(rp.score).toBe(S.scoreOf(r.sim));
      expect(rp.ticks).toBe(r.sim.tick);
      expect(rp.distance).toBe(S.distanceM(r.sim));
      expect(rp.chosen).toEqual(r.sim.chosen);
      // その場の遊び方（刻みごとに操作を当てる）とも一致
      const live = liveRun(seed, ch, r.inputs);
      expect(S.digest(live)).toBe(S.digest(r.sim));
    }
  });

  it("種が違えば面が違う", () => {
    const a = S.traceRun(1, "drikin", []);
    const b = S.traceRun(2, "drikin", []);
    expect(a.digests).not.toEqual(b.digests);
  });

  it("状態の数はすべて整数", () => {
    const s = S.newSim(4242, "zenji");
    const r = botRun(4242, "zenji", { maxTicks: 4000 });
    expect(allIntegers(r.sim)).toBeNull();
    for (let i = 0; i < 2000 && !s.dead; i++) {
      if (i % 37 === 0) S.simInput(s, 1);
      if (i % 37 === 9) S.simInput(s, 0);
      if (s.choosing) S.simInput(s, 2);
      S.simStep(s);
      expect(allIntegers(s)).toBeNull();
    }
  });

  it("ソースに import・浮動小数点の関数・Date・Math.random がない", () => {
    const src = readFileSync(path.join(__dirname, "../minigame/sim.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).not.toMatch(/^\s*import\s/m);
    const maths = [...src.matchAll(/Math\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(maths)).toEqual(new Set(["imul"]));
    expect(src).not.toMatch(/Date|performance|parseFloat|toFixed|\*\*/);
  });
});

describe("記録の形", () => {
  it("刻みの差 * 4 + code、選んだパワーアップも入る", () => {
    const rec = new S.InputRecorder();
    rec.push(10, 1);
    rec.push(15, 0);
    rec.push(15, 2);
    rec.push(600, 3);
    expect(rec.packed).toEqual([41, 20, 2, 2343]);
    expect(S.unpackInputs(rec.packed)).toEqual([
      { tick: 10, code: 1 },
      { tick: 15, code: 0 },
      { tick: 15, code: 2 },
      { tick: 600, code: 3 },
    ]);
  });

  it("500m ごとにパワーアップを選ぶ間は刻みが進まず、選んだものが記録に入る", () => {
    const r = botRun(77, "drikin");
    expect(r.sim.chosen.length).toBeGreaterThan(0);
    const ev = S.unpackInputs(r.inputs)!;
    expect(ev.filter((e) => e.code >= 2).length).toBe(r.sim.chosen.length);
  });

  it("壊れた記録・上限を超える記録・終わらない記録は ok:false", () => {
    expect(S.replay(1, "drikin", "x").ok).toBe(false);
    expect(S.replay(1, "drikin", [1.5]).error).toBe("bad_inputs");
    expect(S.replay(1, "drikin", [-4]).error).toBe("bad_inputs");
    expect(S.replay(1, "drikin", new Array(S.MAX_INPUTS + 1).fill(1)).error).toBe("bad_inputs");
    expect(S.replay(1, "drikin", [(S.MAX_TICKS + 1) * 4]).error).toBe("bad_inputs");
    // パワーアップを選ばずに記録が終わる
    const r = botRun(77, "drikin");
    const ev = S.unpackInputs(r.inputs)!;
    const firstChoose = ev.findIndex((e) => e.code >= 2);
    const cut = r.inputs.slice(0, firstChoose);
    expect(S.replay(77, "drikin", cut).error).toBe("unfinished");
    // 上限の刻みまでに終わらない
    expect(S.replay(77, "drikin", r.inputs, 100).error).toBe("too_long");
  });
});

describe("ルールの固定（ENGINE_VERSION 1）", () => {
  it("版は 1", () => {
    expect(S.ENGINE_VERSION).toBe(1);
  });
  it("決まった種・決まった操作の答え（ルールを変えたら ENGINE_VERSION を上げてここを直す）", () => {
    // 何もしない（跳ばない）とすぐ終わる
    const idle = S.replay(12345, "drikin", []);
    // 一定の間隔で跳ぶ
    const rec = new S.InputRecorder();
    for (let t = 200; t < 6000; t += 45) {
      rec.push(t, 1);
      rec.push(t + 14, 0);
    }
    const periodic = S.traceRun(999, "matsuo", rec.packed);
    expect({ idle: [idle.ticks, idle.score, idle.cause], periodic: [periodic.result.ticks, periodic.result.score, periodic.result.cause, periodic.digests.at(-1)] }).toMatchInlineSnapshot(`
      {
        "idle": [
          637,
          159,
          "xlr",
        ],
        "periodic": [
          723,
          273,
          "box",
          184248927,
        ],
      }
    `);
  });
});

describe("手触り", () => {
  it("最初の 3 秒（助走）は障害物に届かない", () => {
    for (let seed = 1; seed < 30; seed++) {
      const s = S.newSim(seed, "drikin");
      for (let t = 0; t < S.RUNUP_TICKS; t++) {
        S.simStep(s);
        expect(s.ev & S.E_HIT).toBe(0);
      }
    }
  });

  it("うまく避け続けても、締め切りの壁が 3〜4 分ほどで追いつく", () => {
    const r = botRun(5, "drikin");
    expect(r.sim.cause).toBe("deadline");
    expect(r.sim.tick / 60).toBeGreaterThan(150);
    expect(r.sim.tick / 60).toBeLessThan(300);
  });

  it("松尾は空中でもう一度跳べる・善司は障害物の手前でスロー", () => {
    const m = S.newSim(1, "matsuo");
    S.simInput(m, 1);
    S.simStep(m);
    S.simInput(m, 0);
    for (let i = 0; i < 5; i++) S.simStep(m);
    S.simInput(m, 1);
    expect(m.ev & S.E_AIRJUMP).toBeTruthy();
    const d = S.newSim(1, "drikin");
    S.simInput(d, 1);
    S.simStep(d);
    S.simInput(d, 0);
    for (let i = 0; i < 5; i++) S.simStep(d);
    S.simInput(d, 1);
    expect(d.ev & S.E_AIRJUMP).toBe(0);

    const z = S.newSim(3, "zenji");
    let slowed = false;
    for (let i = 0; i < 1200 && !z.dead; i++) {
      S.simStep(z);
      if (z.ev & S.E_SLOW) slowed = true;
    }
    expect(slowed).toBe(true);
  });

  it("長押しは軽く押すより高く跳ぶ", () => {
    const peak = (hold: number) => {
      const s = S.newSim(1, "drikin");
      S.simInput(s, 1);
      let top = 0;
      for (let i = 0; i < 60; i++) {
        if (i === hold) S.simInput(s, 0);
        S.simStep(s);
        top = Math.max(top, s.h >> 8);
      }
      return top;
    };
    expect(peak(1)).toBeGreaterThanOrEqual(16);
    expect(peak(1)).toBeLessThan(31); // 軽く押すだけではマイクスタンド（31）を越せない
    expect(peak(30)).toBeGreaterThan(36);
  });
});
