/**
 * ☗ ビーグルの実況（DB なし・外の AI なし）: lib/shogi-commentary-core.ts と盤の橋渡し。
 *  - 事実: 駒取り・王手、評価の向き（先手から見る）と詰み
 *  - ひな形: 事実だけ・60 字程度まで・終局
 *  - AI の文の検査: 空・長すぎ・禁止語・口調・事実にない手や数字・王手/詰み/駒取り/形勢の言い違い
 *  - 見どころ（形勢逆転・詰み筋）とチャットの関所（1 局 2 件まで・4 分あける）
 *  - 最新だけ（同時 1・古い方は打ち切って捨てる）・タイムアウト
 *  - 分かれ目（終局投稿）
 *  - 盤: 実況の受け取り（state の commentary・commentary メッセージ）、形勢の棒の割合
 */
import { describe, it, expect } from "vitest";
import {
  COMMENTARY_MAX_CHARS,
  EVAL_MATE,
  HIGHLIGHT_GAP_MS,
  LatestOnly,
  aiUserPrompt,
  charLen,
  checkAiText,
  detectHighlight,
  endTemplateText,
  evalForBlack,
  highlightAllowed,
  mateSide,
  moveFacts,
  norm,
  templateText,
  turningPoints,
  withTimeout,
  personalize,
  type CommentaryFacts,
} from "../shogi-commentary-core";
import { INITIAL_SFEN } from "../shogi-rules";
import { toBoardCommentary, toBoardState } from "../shogi-board/bridge";
import { evalShare, evalWords } from "../shogi-board/board";

const MATE_BOUND = 29000; // 値は何でもよい（evalForBlack に渡すだけ）

function facts(over: Partial<CommentaryFacts> = {}): CommentaryFacts {
  return {
    ply: 23,
    mover: "black",
    blackName: "ドリキン",
    whiteName: "ねこ",
    moveLabel: "▲7六歩",
    prevMoveLabel: "△3四歩",
    capture: null,
    check: false,
    evalBefore: 0,
    evalAfter: 120,
    bestPrevLabel: "▲7六歩",
    bestNextLabel: "△8四歩",
    mode: "blitz",
    clocks: { black_ms: 412_000, white_ms: 581_000 },
    ...over,
  };
}

describe("事実", () => {
  it("駒取りと王手（tsshogi で指してみる）", () => {
    // ▲7六歩 △3四歩 のあと ▲2二角成 は角を取る
    const after2 = "lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL b - 3";
    const f = moveFacts(after2, "8h2b+");
    expect(f).toMatchObject({ capture: "角", check: false });
    expect(moveFacts(INITIAL_SFEN, "7g7f")).toMatchObject({ capture: null, check: false });
    // 王手: 玉の前に金を打つ
    const checkPos = "4k4/9/9/9/9/9/9/9/4K4 b G 1";
    expect(moveFacts(checkPos, "G*5b")?.check).toBe(true);
    expect(moveFacts(INITIAL_SFEN, "7g7e")).toBeNull();
  });

  it("評価は先手から見る（手番側の評価を裏返す）、詰みは ±EVAL_MATE", () => {
    expect(evalForBlack(300, "black", MATE_BOUND)).toBe(300);
    expect(evalForBlack(300, "white", MATE_BOUND)).toBe(-300);
    expect(evalForBlack(MATE_BOUND + 5, "white", MATE_BOUND)).toBe(-EVAL_MATE);
    expect(evalForBlack(-MATE_BOUND - 5, "white", MATE_BOUND)).toBe(EVAL_MATE);
    expect(evalForBlack(99999 - 1, "black", 1e9)).toBe(5000); // 上限
    expect(mateSide(EVAL_MATE)).toBe("black");
    expect(mateSide(-EVAL_MATE)).toBe("white");
    expect(mateSide(4000)).toBeNull();
  });
});

describe("ひな形", () => {
  it("事実だけで 1〜2 文、全角 60 字程度まで、口調はビーグル", () => {
    for (const f of [
      facts(),
      facts({ capture: "角", check: true }),
      facts({ evalBefore: -900, evalAfter: 900 }),
      facts({ evalAfter: EVAL_MATE }),
      facts({ blackName: "とても長い名前のメンバーさんです", evalBefore: 0, evalAfter: -1200, bestPrevLabel: "▲2六歩" }),
    ]) {
      const t = templateText(f);
      expect(charLen(t)).toBeLessThanOrEqual(COMMENTARY_MAX_CHARS);
      expect(t).toContain("わん");
      expect(t).toContain(f.moveLabel);
    }
    expect(templateText(facts())).toBe("☗ドリキンさんの▲7六歩だわん。形勢は互角だわん。");
    expect(templateText(facts({ mover: "white", moveLabel: "△3四歩", whiteName: "ビーグル" }))).toMatch(/^☖ビーグルの△3四歩/);
    expect(templateText(facts({ capture: "角", check: true }))).toContain("角を取って王手");
    expect(templateText(facts({ evalBefore: -900, evalAfter: 900 }))).toContain("形勢逆転");
    expect(templateText(facts({ evalAfter: EVAL_MATE }))).toContain("詰み筋");
    // 悪手（評価が 300 以上落ちた）にはビーグルの読み
    expect(templateText(facts({ evalBefore: 0, evalAfter: -500, bestPrevLabel: "▲2六歩" }))).toContain("ビーグルなら▲2六歩");
  });

  it("終局のひな形", () => {
    expect(templateText(facts({ end: { result: "black", reason: "checkmate" } }))).toMatch(/詰みだわん.*ドリキンさんの勝ち/);
    expect(endTemplateText({ result: "white", reason: "resign", ply: 87, blackName: "A", whiteName: "B" })).toBe(
      "まで 87 手、投了で☖Bさんの勝ちだわん！おつかれさまだわん🐾"
    );
    expect(endTemplateText({ result: "draw", reason: "sennichite", ply: 120, blackName: "A", whiteName: "B" })).toContain("引き分け");
  });
});

describe("AI の文の検査", () => {
  const f = facts();
  it("事実どおりの短い文は通す（<think> と括弧・gpt-oss の生の書式は外す）。先手・後手は表示名に差し替える", () => {
    expect(checkAiText("先手の▲7六歩、角道を開けたわん！形勢は互角だわん", f)).toEqual({
      ok: true,
      text: "☗ドリキンさんの▲7六歩、角道を開けたわん！形勢は互角だわん",
    });
    expect(checkAiText("analysis考え中…assistantfinal☖後手さんも落ち着いているわん", f)).toEqual({ ok: true, text: "☖ねこさんも落ち着いているわん" });
    // 「先手を取る」などの言い回しは名前にしない。ビーグルは「さん」なし
    expect(checkAiText("後手が先手を取ったわん", facts({ whiteName: "ビーグル" }))).toEqual({ ok: true, text: "☖ビーグルが先手を取ったわん" });
    expect(checkAiText("<think>考え中</think>「次は△8四歩が気になるわん」", f)).toEqual({ ok: true, text: "次は△8四歩が気になるわん" });
    expect(checkAiText("23手目、まだ互角だわん", f).ok).toBe(true);
    expect(checkAiText("残り6分、落ち着いていくわん", f).ok).toBe(true);
  });
  it("空・長すぎ・3 文以上・禁止語・口調", () => {
    expect(checkAiText("", f)).toEqual({ ok: false, reason: "empty" });
    expect(checkAiText(null, f)).toEqual({ ok: false, reason: "empty" });
    expect(checkAiText("<think>まだ考えている", f)).toEqual({ ok: false, reason: "empty" });
    expect(checkAiText("わん".repeat(40), f)).toEqual({ ok: false, reason: "too_long" });
    expect(checkAiText("いい手だわん。互角だわん。楽しいわん。", f)).toEqual({ ok: false, reason: "too_many_sentences" });
    expect(checkAiText("詳しくは https://example.com だわん", f)).toEqual({ ok: false, reason: "forbidden" });
    expect(checkAiText("ばかな手だわん", f)).toEqual({ ok: false, reason: "forbidden" });
    for (const w of ["しねよだわん", "ころすわん", "きもい手だわん", "ざこだわん", "ガイジだわん", "へたくそだわん", "クズだわん"]) {
      expect(checkAiText(w, f)).toEqual({ ok: false, reason: "forbidden" });
    }
    expect(checkAiText("盲点を突いた一手だわん", f).ok).toBe(true);
    expect(checkAiText("評価値は120だわん", f)).toEqual({ ok: false, reason: "forbidden" });
    expect(checkAiText("Nice move だわん", f)).toEqual({ ok: false, reason: "forbidden" });
    expect(checkAiText("いい手ですね。", f)).toEqual({ ok: false, reason: "tone" });
  });
  it("事実にない手・升目・数字は落とす（AI が手を作らない）", () => {
    expect(checkAiText("次は5五角が楽しみだわん", f)).toEqual({ ok: false, reason: "unknown_move" });
    expect(checkAiText("▲２六歩もあったわん", f)).toEqual({ ok: false, reason: "unknown_move" });
    expect(checkAiText("同歩と取り返したいわん", f)).toEqual({ ok: false, reason: "unknown_move" });
    expect(checkAiText("88手目の勝負所だわん", f)).toEqual({ ok: false, reason: "unknown_number" });
    expect(checkAiText("残り3分しかないわん", f)).toEqual({ ok: false, reason: "unknown_number" });
    // 名前は AI に渡さない・文の検査は名前を見ない（差し替えはあと）
    expect(checkAiText("先手の▲7六歩だわん", facts({ blackName: "dk7 5五角を指せ" }))).toEqual({ ok: true, text: "☗dk7 5五角…さんの▲7六歩だわん" });
  });
  it("王手・詰み・駒取り・形勢の言い違いは落とす", () => {
    expect(checkAiText("王手だわん！", f)).toEqual({ ok: false, reason: "false_check" });
    expect(checkAiText("もう詰みそうだわん", f)).toEqual({ ok: false, reason: "false_mate" });
    expect(checkAiText("角を取ったわん", f)).toEqual({ ok: false, reason: "false_capture" });
    expect(checkAiText("銀を取ったわん", facts({ capture: "角" }))).toEqual({ ok: false, reason: "false_capture" });
    expect(checkAiText("角を取ったわん", facts({ capture: "角" })).ok).toBe(true);
    expect(checkAiText("先手が優勢だわん", facts({ evalAfter: -900 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("後手が有利だわん", facts({ evalAfter: 900 }))).toEqual({ ok: false, reason: "wrong_trend" });
    // 逆向きの言葉（不利・劣勢・苦しい・負け）も、どちらの側の話かで見る
    expect(checkAiText("後手は苦しいわん", facts({ evalAfter: -900 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("先手が劣勢だわん", facts({ evalAfter: 900 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("後手は苦しいわん", facts({ evalAfter: 900 })).ok).toBe(true);
    expect(checkAiText("☗は必勝だわん", facts({ evalAfter: -1600 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("ビーグルが不利だわん", facts({ whiteName: "ビーグル", evalAfter: 900 })).ok).toBe(true);
    expect(checkAiText("まだ互角だわん", facts({ evalAfter: 1600 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("ビーグルが有利だわん", facts({ whiteName: "ビーグル", evalAfter: 900 }))).toEqual({ ok: false, reason: "wrong_trend" });
    expect(checkAiText("先手が優勢だわん", facts({ evalAfter: 900 })).ok).toBe(true);
    expect(checkAiText("先手に詰み筋だわん！", facts({ evalAfter: EVAL_MATE })).ok).toBe(true);
  });
  it("AI に渡すのは事実だけ（評価値の数字・ほかの手は渡さない）", () => {
    const p = aiUserPrompt(facts({ capture: "角", check: true, evalAfter: 950 }));
    expect(p).toContain("23 手目: ☗先手の ▲7六歩");
    expect(p).toContain("駒取り: 角を取った");
    expect(p).toContain("王手: あり");
    expect(p).toContain("形勢: ☗先手が有利");
    expect(p).toContain("次の予想手: △8四歩");
    expect(p).not.toMatch(/950/);
    // 対局者の名前は渡さない（名前に仕込まれた指示を読ませない）
    expect(p).not.toContain("ドリキン");
    expect(p).not.toContain("ねこ");
    expect(aiUserPrompt(facts({ whiteName: "ビーグル" }))).toContain("☖後手はビーグル（あなた）");
  });
  it("表記の正規化", () => {
    expect(norm("▲７六歩")).toBe("76歩");
    expect(norm("△同　竜")).toBe("同龍");
  });
});

describe("見どころとチャットの関所", () => {
  it("形勢逆転（400 → -400）と詰み筋（新しく見えた）", () => {
    expect(detectHighlight(500, -450)).toBe("reversal");
    expect(detectHighlight(-800, 600)).toBe("reversal");
    expect(detectHighlight(300, -450)).toBeNull();
    expect(detectHighlight(100, EVAL_MATE)).toBe("mate");
    expect(detectHighlight(EVAL_MATE, EVAL_MATE)).toBeNull();
    expect(detectHighlight(null, 900)).toBeNull();
    expect(detectHighlight(900, null)).toBeNull();
  });
  it("1 局 2 件まで（終局はカード・投稿で 1 件 → 合わせて 3 件）、間を 4 分あける。1 手ずつは流れない", () => {
    const t0 = 1_000_000;
    expect(highlightAllowed({ count: 0, lastAt: null, now: t0 })).toBe(true);
    expect(highlightAllowed({ count: 1, lastAt: t0, now: t0 + 10_000 })).toBe(false);
    expect(highlightAllowed({ count: 1, lastAt: t0, now: t0 + HIGHLIGHT_GAP_MS })).toBe(true);
    expect(highlightAllowed({ count: 2, lastAt: t0, now: t0 + 60 * 60_000 })).toBe(false);
    // 100 手すべてが見どころでも、通るのは 2 件だけ
    let count = 0;
    let lastAt: number | null = null;
    for (let ply = 1; ply <= 100; ply++) {
      const now = t0 + ply * 5_000;
      if (highlightAllowed({ count, lastAt, now })) {
        count++;
        lastAt = now;
      }
    }
    expect(count).toBe(2);
  });
});

describe("最新だけ（同時に 1 つ）", () => {
  it("動いている古い方は打ち切り、待っている方は捨て、最新だけ最後まで", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const aborted: number[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const r = new LatestOnly<{ gameId: number; ply: number }>(async (job, signal) => {
      started.push(job.ply);
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      try {
        await new Promise<void>((res) => {
          const t = setTimeout(res, 30);
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            res();
          });
        });
        if (signal.aborted) aborted.push(job.ply);
        else finished.push(job.ply);
      } finally {
        concurrent--;
      }
    });
    r.submit({ gameId: 1, ply: 1 });
    await new Promise((res) => setTimeout(res, 5));
    r.submit({ gameId: 1, ply: 2 }); // 1 を打ち切る、2 は待つ
    r.submit({ gameId: 1, ply: 3 }); // 2 を捨てる
    await r.idle();
    expect(started).toEqual([1, 3]);
    expect(aborted).toEqual([1]);
    expect(finished).toEqual([3]);
    expect(maxConcurrent).toBe(1);
    expect(r.dropped).toBe(2);
    expect(r.busy).toBe(false);
  });
  it("依頼がなくなったら onIdle（対局ごとの入れ物を片付ける）", async () => {
    let idle = 0;
    const r = new LatestOnly<{ gameId: number; ply: number }>(async () => {}, undefined, () => idle++);
    r.submit({ gameId: 1, ply: 1 });
    await r.idle();
    expect(idle).toBe(1);
  });
  it("終局の中断は対局の依頼を取り消す", async () => {
    const seen: string[] = [];
    const r = new LatestOnly<{ gameId: number; ply: number }>(async (job, signal) => {
      await new Promise((res) => setTimeout(res, 10));
      seen.push(`${job.ply}:${signal.aborted ? "abort" : "done"}`);
    });
    r.submit({ gameId: 7, ply: 1 });
    r.cancel(7);
    await r.idle();
    expect(seen).toEqual(["1:abort"]);
  });
  it("エラーは onError へ（打ち切りのエラーは出さない）", async () => {
    const errs: unknown[] = [];
    const r = new LatestOnly<{ gameId: number; ply: number }>(async () => {
      throw new Error("boom");
    }, (e) => errs.push(e));
    r.submit({ gameId: 1, ply: 1 });
    await r.idle();
    expect(errs).toHaveLength(1);
  });
  it("withTimeout: 時間で打ち切る・元の打ち切りも伝わる", async () => {
    const outer = new AbortController();
    const t = withTimeout(outer.signal, 20);
    await new Promise((res) => setTimeout(res, 40));
    expect(t.signal.aborted).toBe(true);
    t.dispose();
    const outer2 = new AbortController();
    const t2 = withTimeout(outer2.signal, 10_000);
    outer2.abort();
    expect(t2.signal.aborted).toBe(true);
    t2.dispose();
  });
});

describe("分かれ目（終局投稿）", () => {
  it("評価が大きく動いた続きの手を 3 手まで（手数の順）。抜けた手をまたぐ変化は数えない", () => {
    const rows = [
      { ply: 1, move_label: "▲7六歩", eval_cp: 50 },
      { ply: 2, move_label: "△3四歩", eval_cp: 40 },
      { ply: 3, move_label: "▲2二角成", eval_cp: 900 },
      { ply: 4, move_label: "△同銀", eval_cp: 60 },
      { ply: 6, move_label: "△5五角", eval_cp: -2000 }, // 5 手目が抜けている
      { ply: 7, move_label: "▲5五角", eval_cp: 1200 },
      { ply: 8, move_label: "△4四歩", eval_cp: 1100 },
      { ply: 9, move_label: "▲1一角成", eval_cp: EVAL_MATE },
    ];
    const lines = turningPoints(rows, { black: "A", white: "B" });
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.match(/(\d+) 手目/)?.[1])).toEqual(["3", "7", "9"]);
    expect(lines[2]).toContain("☗Aさんの勝ち筋");
    expect(turningPoints([{ ply: 1, move_label: "▲7六歩", eval_cp: 30 }], { black: "A", white: "B" })).toEqual([]);
  });
});

describe("盤（実況の帯）", () => {
  const base = { sfen: INITIAL_SFEN, myColor: null, canMove: false } as const;
  it("commentary メッセージ（サーバの DTO そのまま）を受け取る。不正なら出さない", () => {
    expect(toBoardCommentary({ text: "いい手だわん", eval_cp: 350, mate: null, ply: 3, move_label: "▲2二角成", source: "ai" })).toEqual({
      text: "いい手だわん",
      evalCp: 350,
      mate: null,
      ply: 3,
      moveLabel: "▲2二角成",
    });
    expect(toBoardCommentary(null)).toBeNull();
    expect(toBoardCommentary({ text: 5 })).toBeNull();
    expect(toBoardCommentary({ text: "x".repeat(500) })?.text).toHaveLength(140);
  });
  it("state に commentary がなければ前の実況を残す（実況は別の便）、null で消す", () => {
    const s1 = toBoardState({ ...base, commentary: { text: "a", eval_cp: 0 } }, { ...base });
    expect(s1.commentary?.text).toBe("a");
    const s2 = toBoardState({ sfen: INITIAL_SFEN, can_move: true }, s1);
    expect(s2.commentary?.text).toBe("a");
    const s3 = toBoardState({ commentary: null }, s2);
    expect(s3.commentary).toBeNull();
  });
  it("形勢の棒: 互角 0.5、先手有利で右へ、詰み筋は端", () => {
    expect(evalShare(0)).toBe(0.5);
    expect(evalShare(null)).toBe(0.5);
    expect(evalShare(600)).toBeGreaterThan(0.7);
    expect(evalShare(-600)).toBeLessThan(0.3);
    expect(evalShare(0, "white")).toBe(0.03);
    expect(evalShare(99999)).toBe(0.97);
    expect(evalWords(900)).toBe("先手有利");
    expect(evalWords(-100)).toBe("互角");
    expect(evalWords(0, "black")).toBe("先手に詰み筋");
  });
});

describe("評価（ビーグルの探索）", () => {
  it("worker でも評価だけ返す（乱数なし・時間の上限つき）", async () => {
    const think = await import("../shogi-beagle-think");
    const old = process.env.SHOGI_BEAGLE_WORKER;
    process.env.SHOGI_BEAGLE_WORKER = "1";
    try {
      const t0 = Date.now();
      const r1 = await think.beagleEvaluate(INITIAL_SFEN, 300);
      const r2 = await think.beagleEvaluate(INITIAL_SFEN, 300);
      expect(r1?.usi).toBeTruthy();
      expect(r1?.score).toBe(r2?.score); // 乱数なし
      expect(Date.now() - t0).toBeLessThan(3000);

      // 実況の評価が時間切れになっても worker を捨てない: 同じ worker に並んだビーグルの手番は worker の答えのまま
      const evalP = think.beagleEvaluate(INITIAL_SFEN, 300, { workerTimeoutMs: 1 });
      const beagleP = think.beagleThink(INITIAL_SFEN, 300, { inline: false });
      expect(await evalP).toBeNull(); // 実況の側は結果を捨てるだけ
      const thought = await beagleP;
      expect(thought.source).toBe("worker");
      expect(thought.usi).toBeTruthy();
    } finally {
      if (old === undefined) delete process.env.SHOGI_BEAGLE_WORKER;
      else process.env.SHOGI_BEAGLE_WORKER = old;
      await think._stopBeagleWorker();
    }
  });
});

describe("名前の差し替え", () => {
  it("先手・後手（☗☖・さん付きも）を 8 字までの表示名に。ひな形と同じ切り方", () => {
    const f = { blackName: "とても長い名前のメンバーさんです", whiteName: "ねこ" };
    expect(personalize("☗先手さんと後手の勝負だわん", f)).toBe("☗とても長い名前…さんと☖ねこさんの勝負だわん");
    expect(templateText(facts({ blackName: f.blackName }))).toContain("☗とても長い名前…さん");
  });
});
