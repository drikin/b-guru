/**
 * ☗ 将棋のルール（lib/shogi-rules.ts、tsshogi 2.3.4 の上の補助関数）:
 *  - 初期局面の合法手 30、打ち歩詰め・二歩・王手放置・行き所のない駒は合法手に入らない
 *  - 詰み（指し手のない側の負け）、千日手（同一局面 4 回 → 引き分け）、連続王手の千日手（王手をかけ続けた側の負け）
 *  - 表記「▲7六歩」「△同歩」、KIF の書き出し
 */
import { describe, it, expect } from "vitest";
import { Position } from "tsshogi";
import {
  INITIAL_SFEN,
  buildKif,
  judge,
  labelFor,
  legalUsi,
  normalizeLabel,
  replay,
  sideToMove,
  tryMove,
} from "../shogi-rules";

describe("合法手", () => {
  it("平手の初期局面は 30 手", () => {
    expect(legalUsi(INITIAL_SFEN)).toHaveLength(30);
    expect(new Position().sfen).toBe(INITIAL_SFEN);
  });

  it("打ち歩詰めは合法手に入らない（ほかの駒を打つ詰みは入る）", () => {
    const pawn = "8k/6G2/9/7N1/9/9/9/9/4K4 b P 1";
    expect(legalUsi(pawn)).not.toContain("P*1b");
    const gold = "8k/6G2/9/7N1/9/9/9/9/4K4 b G 1";
    expect(legalUsi(gold)).toContain("G*1b");
  });

  it("二歩は打てない・行き所のない升に打てない", () => {
    const nifu = "4k4/9/9/9/9/9/4P4/9/4K4 b P 1";
    const moves = legalUsi(nifu);
    expect(moves).not.toContain("P*5e");
    expect(moves).not.toContain("P*4a"); // 1 段目の歩
    expect(moves).toContain("P*4e");
    const knight = legalUsi("4k4/9/9/9/9/9/9/9/4K4 b N 1");
    expect(knight).not.toContain("N*4b"); // 2 段目の桂
    expect(knight).toContain("N*4c");
  });

  it("王手放置はできない（玉で取る・合駒する手だけ）", () => {
    const chk = "4k4/9/9/9/9/9/9/4r4/4K1G2 b - 1";
    const moves = legalUsi(chk);
    expect(moves).not.toContain("3i3h");
    expect(moves).toContain("5i5h");
  });

  it("行き所のない駒は成りしかない（不成は合法手に入らない）", () => {
    const p = "4k4/2P6/9/9/9/9/9/9/4K4 b - 1";
    const moves = legalUsi(p);
    expect(moves).toContain("7b7a+");
    expect(moves).not.toContain("7b7a");
    // 成っても成らなくてもよい手は両方
    const s = legalUsi("4k4/9/9/5S3/9/9/9/9/4K4 b - 1");
    expect(s).toContain("4d4c");
    expect(s).toContain("4d4c+");
  });
});

describe("終局の判定", () => {
  it("詰み: 指した側の勝ち（頭金）", async () => {
    const { Record } = await import("tsshogi");
    const rec = new Record(Position.newBySFEN("4k4/9/4P4/9/9/9/9/9/4K4 b G 1")!);
    expect(judge(rec)).toBeNull();
    rec.append(rec.position.createMoveByUSI("G*5b")!);
    expect(rec.position.checked).toBe(true);
    expect(legalUsi(rec.position.sfen)).toHaveLength(0);
    expect(judge(rec)).toEqual({ result: "black", reason: "checkmate" });
  });

  it("平手からの普通の手では終局しない", () => {
    const r = tryMove(["7g7f", "3c3d"], "2g2f");
    expect(r.ok && r.end).toBeNull();
  });

  it("千日手: 同一局面 4 回で引き分け", () => {
    const seq: string[] = [];
    let end = null;
    for (let i = 0; i < 3; i++) {
      for (const u of ["5i4h", "5a4b", "4h5i", "4b5a"]) {
        const r = tryMove(seq, u);
        if (!r.ok) throw new Error(u);
        seq.push(u);
        end = r.end;
      }
    }
    expect(end).toEqual({ result: "draw", reason: "sennichite" });
  });

  it("連続王手の千日手: 王手をかけ続けた側の負け", async () => {
    const { Record } = await import("tsshogi");
    const rec = new Record(Position.newBySFEN("8k/9/9/9/9/9/9/9/K6R1 b - 1")!);
    for (let i = 0; i < 3; i++) for (const u of ["2i1i", "1a2a", "1i2i", "2a1a"]) rec.append(rec.position.createMoveByUSI(u)!);
    // 先手の飛車が王手をかけ続けた → 後手の勝ち
    expect(judge(rec)).toEqual({ result: "white", reason: "perpetual_check" });
  });
});

describe("表記と KIF", () => {
  it("▲7六歩・△同歩・半角数字", () => {
    expect(normalizeLabel("☗７六歩")).toBe("▲7六歩");
    const r = replay(["7g7f", "3c3d", "8h2b+", "3a2b"]);
    if (r instanceof Error) throw r;
    expect(r.labels).toEqual(["▲7六歩", "△3四歩", "▲2二角成", "△同銀"]);
    expect(sideToMove(4)).toBe("black");
    const pos = Position.newBySFEN(r.sfens[0])!;
    expect(labelFor(pos, "3c3d", "7g7f")).toBe("△3四歩");
  });

  it("反則の手・形の悪い手は指せない", () => {
    expect(tryMove([], "7g7e")).toEqual({ ok: false, error: "illegal" });
    expect(tryMove([], "hello")).toEqual({ ok: false, error: "bad_usi" });
    expect(tryMove(["7g7f"], "7g7f")).toEqual({ ok: false, error: "illegal" }); // 後手の番に先手の駒
  });

  it("KIF: 対局者・持ち時間・消費時間・投了", () => {
    const kif = buildKif({
      usis: ["7g7f", "3c3d"],
      spentMs: [3000, 61000],
      blackName: "ドリキン",
      whiteName: "ねこ",
      startedAt: new Date("2026-10-21T12:00:00Z"),
      endedAt: new Date("2026-10-21T12:05:00Z"),
      mode: "blitz",
      result: "white",
      endReason: "resign",
    });
    expect(kif).toContain("先手：ドリキン");
    expect(kif).toContain("後手：ねこ");
    expect(kif).toContain("開始日時：2026/10/21 21:00:00");
    expect(kif).toContain("10分＋秒読み30秒");
    expect(kif).toMatch(/1 ７六歩\(77\)\s+\( 0:03\//);
    expect(kif).toMatch(/2 ３四歩\(33\)\s+\( 1:01\//);
    expect(kif).toContain("投了");
  });
});
