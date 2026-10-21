/**
 * ☗ ビーグルの頭（lib/shogi-engine.ts）と考える道（lib/shogi-beagle-think.ts）。
 *  - 探索用の合法手生成が tsshogi（shogi-rules.ts）と一致する（ランダムな対局の各局面）
 *  - 探索が合法手だけを返す・1 手詰めは必ず指す・ただで駒を取られる手を避ける・時間の上限を守る
 */
import { describe, it, expect } from "vitest";
import { Position } from "tsshogi";
import { INITIAL_SFEN, legalUsi, legalMovesOf } from "../shogi-rules";
import { beagleSearch, engineLegalUsi } from "../shogi-engine";

function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) % 1_000_000) / 1_000_000;
  };
}

/** 平手からランダムに指した局面の SFEN を集める（取る手を多めに選んで駒を持たせる）。 */
function randomPositions(games: number, plies: number, seed: number): string[] {
  const r = rng(seed);
  const out: string[] = [];
  for (let g = 0; g < games; g++) {
    const pos = Position.newBySFEN(INITIAL_SFEN)!;
    for (let i = 0; i < plies; i++) {
      const ms = legalMovesOf(pos);
      if (ms.length === 0) break;
      const caps = ms.filter((m) => pos.board.at(m.to));
      const pick = caps.length && r() < 0.6 ? caps[Math.floor(r() * caps.length)] : ms[Math.floor(r() * ms.length)];
      pos.doMove(pick);
      out.push(pos.sfen);
    }
  }
  return out;
}

describe("合法手生成（tsshogi と一致）", () => {
  it("ランダムな局面で同じ合法手", () => {
    const sfens = [INITIAL_SFEN, ...randomPositions(12, 90, 7)];
    let checked = 0;
    for (const sfen of sfens) {
      const a = engineLegalUsi(sfen, true).sort();
      const b = legalUsi(sfen).sort();
      expect(a, sfen).toEqual(b);
      checked++;
    }
    expect(checked).toBeGreaterThan(500);
  });
  it("打ち歩詰めは指せない・二歩は打てない", () => {
    // 後手玉 1a、1b に歩を打つと詰む（2a・2b は先手の金が利く）→ 打ち歩詰めで打てない
    const sfen = "7nk/9/7G1/9/9/9/9/9/K8 b P 1";
    expect(legalUsi(sfen)).not.toContain("P*1b");
    expect(engineLegalUsi(sfen)).not.toContain("P*1b");
    expect(engineLegalUsi(sfen).sort()).toEqual(legalUsi(sfen).sort());
  });
});

describe("探索", () => {
  it("合法手だけを返す（ランダムな局面）", () => {
    for (const sfen of randomPositions(4, 60, 11).filter((_, i) => i % 7 === 0)) {
      const r = beagleSearch(sfen, { timeMs: 150, maxDepth: 2 });
      const legal = legalUsi(sfen);
      if (legal.length === 0) expect(r.usi).toBeNull();
      else expect(legal).toContain(r.usi);
    }
  });

  it("1 手詰めがあれば必ず指す", () => {
    // 頭金: 後手玉 5a、先手の歩 5c・持ち駒の金 → G*5b で詰み
    const cases = [
      { sfen: "4k4/9/4P4/9/9/9/9/9/4K4 b G 1", mate: ["G*5b"] },
      // 後手番: 先手玉 5i、後手の歩 5g・持ち駒の金 → G*5h
      { sfen: "4k4/9/9/9/9/9/4p4/9/4K4 w g 1", mate: ["G*5h"] },
      // 一段目の飛車: 後手玉 1a・1b 2b の歩で逃げ場なし → 9i の飛車が 9a へ（成っても成らなくても詰み）
      { sfen: "8k/7pp/9/9/9/9/9/9/R7K b - 1", mate: ["9i9a+", "9i9a"] },
    ];
    for (const c of cases) {
      for (let i = 0; i < 5; i++) {
        const r = beagleSearch(c.sfen, { timeMs: 500 });
        expect(r.mateIn1).toBe(true);
        expect(c.mate).toContain(r.usi);
      }
    }
  });

  it("ただで駒を取られる手を避ける・ただの駒は取る", () => {
    // 先手陣の 2h に後手の飛車がただで入っている（3i の銀で取れる）→ 取る
    const free = "lnsgkgsnl/9/ppppppppp/9/9/2P6/PP1PPPPPP/1B5r1/LNSGKGSNL b - 1";
    const r = beagleSearch(free, { timeMs: 800 });
    expect(r.usi?.slice(2, 4)).toBe("2h");
    // 先手の飛車 2e: 2d に出ると 2c の歩に取られる（ただ）。飛車は 2d に行かない。
    const hang = "lnsgkgsnl/1r5b1/ppppppppp/9/7R1/9/PPPPPPPP1/1B7/LNSGKGSNL b - 1";
    for (let i = 0; i < 5; i++) {
      const h = beagleSearch(hang, { timeMs: 600 });
      expect(h.usi).not.toBe("2e2d");
    }
  });

  it("自分の 1 手詰めを見落とさない（詰まされる手を避ける）", () => {
    // 先手玉 5i の頭（5h）に後手の金を打たれると詰む形: 後手の歩 5g（と金 5g でも）・持ち駒の金。
    // 先手は 5h を守るか 5g を取る手を選ぶ（5h に利きを作らない手はすべて 1 手で詰まされる）。
    const sfen = "4k4/9/9/9/9/9/4p4/9/3RK4 b 2Gg 1";
    for (let i = 0; i < 5; i++) {
      const r = beagleSearch(sfen, { timeMs: 800 });
      expect(r.usi).not.toBeNull();
      // 指したあとの局面で後手に 1 手詰めがない
      const pos = Position.newBySFEN(sfen)!;
      pos.doMove(pos.createMoveByUSI(r.usi!)!);
      const after = beagleSearch(pos.sfen, { timeMs: 300, maxDepth: 1 });
      expect(after.mateIn1, r.usi!).toBe(false);
    }
  });

  it("時間の上限を守る（中盤の局面）", () => {
    const mids = randomPositions(3, 50, 3).filter((_, i) => i % 25 === 24);
    for (const sfen of mids) {
      const t0 = Date.now();
      const r = beagleSearch(sfen, { timeMs: 300, maxDepth: 4 });
      const el = Date.now() - t0;
      expect(el).toBeLessThan(300 + 150);
      expect(r.usi === null || legalUsi(sfen).includes(r.usi)).toBe(true);
    }
  });

  it("毎回同じ手にはならない（初手）", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(beagleSearch(INITIAL_SFEN, { timeMs: 300, maxDepth: 2 }).usi!);
    expect(seen.size).toBeGreaterThan(1);
  });
});
