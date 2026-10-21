/**
 * ☗ 将棋の時計（lib/shogi-clock.ts、純関数）:
 *  - 持ち時間 → 秒読み 30 秒（1 手ごとに戻る）→ 時間切れ
 *  - 遅延の補正は 1 手 1 秒まで
 *  - 双方が 1 手目を指すまでは時計を進めない・60 秒で中断
 *  - 再起動をまたぐ: 起動時刻＋10 秒より前の期限は延ばす（止まっていた間は時間切れにしない）
 *  - ゆっくり: 24 時間で一度通知、72 時間で放置負け。募集 15 分・指名 24 時間で期限切れ
 */
import { describe, it, expect } from "vitest";
import {
  ABANDON_MS,
  ABORT_MS,
  BLITZ_BYOYOMI_MS,
  BLITZ_INITIAL_MS,
  LAG_COMP_MS,
  OFFER_TTL_MS,
  OPEN_TTL_MS,
  REMIND_MS,
  RESTART_GRACE_MS,
  deadlineOf,
  dueEvent,
  nextEventAt,
  remainingAt,
  restartShift,
  spend,
  type ClockState,
} from "../shogi-clock";

const T0 = Date.parse("2026-10-21T12:00:00Z");

function blitz(p: Partial<ClockState> = {}): ClockState {
  return {
    status: "active",
    mode: "blitz",
    ply: 10,
    clockBMs: BLITZ_INITIAL_MS,
    clockWMs: BLITZ_INITIAL_MS,
    byoyomiMs: BLITZ_BYOYOMI_MS,
    turnStartedAt: T0,
    createdAt: T0 - 60_000,
    invited: false,
    remindedAt: null,
    ...p,
  };
}

describe("速い将棋の時計", () => {
  it("持ち時間から引く（遅延の補正 1 秒）", () => {
    const r = spend(blitz(), T0 + 5_000);
    expect(r).toEqual({ ok: true, spentMs: 5_000, clockBMs: BLITZ_INITIAL_MS - 4_000, clockWMs: BLITZ_INITIAL_MS });
    // 1 秒以内は減らない
    const fast = spend(blitz(), T0 + 800);
    expect(fast.ok && fast.clockBMs).toBe(BLITZ_INITIAL_MS);
    // 後手の番（ply 奇数）は後手の時計
    const w = spend(blitz({ ply: 11 }), T0 + 11_000);
    expect(w.ok && w.clockWMs).toBe(BLITZ_INITIAL_MS - 10_000);
  });

  it("持ち時間を使い切ったら秒読み 30 秒。秒読みの中で指せば残りは 0 のまま（次の手でまた 30 秒）", () => {
    const g = blitz({ clockBMs: 5_000 });
    const r = spend(g, T0 + LAG_COMP_MS + 5_000 + 29_000);
    expect(r).toMatchObject({ ok: true, clockBMs: 0 });
    // 次の手番（秒読みだけ）
    const g2 = blitz({ clockBMs: 0 });
    expect(spend(g2, T0 + LAG_COMP_MS + 30_000).ok).toBe(true);
    expect(spend(g2, T0 + LAG_COMP_MS + 30_001)).toEqual({ ok: false, reason: "timeout" });
  });

  it("期限と時間切れの判定（タイマー・読み取りのたびの判定に使う）", () => {
    const g = blitz({ clockBMs: 5_000 });
    const dl = deadlineOf(g)!;
    expect(dl).toBe(T0 + 5_000 + BLITZ_BYOYOMI_MS + LAG_COMP_MS);
    expect(nextEventAt(g)).toBe(dl);
    expect(dueEvent(g, dl - 1)).toBeNull();
    expect(dueEvent(g, dl)).toEqual({ kind: "timeout", loser: "black" });
    expect(dueEvent(blitz({ ply: 11, clockWMs: 0 }), T0 + 40_000)).toEqual({ kind: "timeout", loser: "white" });
  });

  it("表示の残り: 手番側だけ減る・秒読みに入ると残りの秒", () => {
    const g = blitz({ clockBMs: 10_000 });
    expect(remainingAt(g, T0 + 6_000)).toEqual({ black_ms: 5_000, white_ms: BLITZ_INITIAL_MS, byoyomi_left_ms: null });
    expect(remainingAt(g, T0 + 21_000)).toEqual({ black_ms: 0, white_ms: BLITZ_INITIAL_MS, byoyomi_left_ms: 20_000 });
  });

  it("双方が 1 手目を指すまでは時計が進まず、60 秒で中断", () => {
    const g0 = blitz({ ply: 0 });
    const r = spend(g0, T0 + 50_000);
    expect(r).toMatchObject({ ok: true, clockBMs: BLITZ_INITIAL_MS });
    expect(spend(g0, T0 + ABORT_MS + LAG_COMP_MS + 1)).toEqual({ ok: false, reason: "aborted" });
    expect(dueEvent(g0, T0 + ABORT_MS + LAG_COMP_MS)).toEqual({ kind: "abort" });
    expect(dueEvent(blitz({ ply: 1 }), T0 + ABORT_MS + LAG_COMP_MS)).toEqual({ kind: "abort" });
    // 2 手目のあとは普通の時計
    expect(dueEvent(blitz({ ply: 2 }), T0 + ABORT_MS + LAG_COMP_MS)).toBeNull();
  });
});

describe("再起動をまたぐ", () => {
  it("起動時刻＋10 秒より前に来る期限は、起動時刻＋10 秒まで延ばす", () => {
    // 残り 5 秒＋秒読みの対局。サーバが 2 分止まって起動した。
    const g = blitz({ clockBMs: 5_000 });
    const boot = T0 + 120_000;
    const shifted = restartShift(g, boot)!;
    expect(shifted).not.toBeNull();
    expect(deadlineOf({ ...g, turnStartedAt: shifted })).toBe(boot + RESTART_GRACE_MS);
    // 延ばしたあとは起動直後に時間切れにならない
    expect(dueEvent({ ...g, turnStartedAt: shifted }, boot + 1_000)).toBeNull();
    expect(dueEvent({ ...g, turnStartedAt: shifted }, boot + RESTART_GRACE_MS)).toEqual({ kind: "timeout", loser: "black" });
  });

  it("期限がまだ先なら動かさない・終わった対局は動かさない", () => {
    expect(restartShift(blitz(), T0 + 1_000)).toBeNull();
    expect(restartShift(blitz({ status: "ended" }), T0 + 10 * 60_000)).toBeNull();
  });
});

describe("ゆっくり・期限切れ", () => {
  const slow = (p: Partial<ClockState> = {}) => blitz({ mode: "slow", clockBMs: 0, clockWMs: 0, byoyomiMs: 0, ...p });

  it("時計はない。24 時間で一度通知、72 時間で放置負け", () => {
    expect(spend(slow(), T0 + 50 * 3600_000)).toMatchObject({ ok: true });
    expect(dueEvent(slow(), T0 + REMIND_MS - 1)).toBeNull();
    expect(dueEvent(slow(), T0 + REMIND_MS)).toEqual({ kind: "remind", side: "black" });
    // 通知済みなら 72 時間まで何もない
    expect(dueEvent(slow({ remindedAt: T0 + REMIND_MS }), T0 + REMIND_MS + 1)).toBeNull();
    expect(nextEventAt(slow({ remindedAt: T0 + REMIND_MS }))).toBe(T0 + ABANDON_MS);
    expect(dueEvent(slow({ remindedAt: T0 + REMIND_MS, ply: 3 }), T0 + ABANDON_MS)).toEqual({ kind: "abandon", loser: "white" });
  });

  it("募集は 15 分、指名は 24 時間で期限切れ", () => {
    const open = blitz({ status: "open", turnStartedAt: null, createdAt: T0 });
    expect(dueEvent(open, T0 + OPEN_TTL_MS - 1)).toBeNull();
    expect(dueEvent(open, T0 + OPEN_TTL_MS)).toEqual({ kind: "expire" });
    const offered = { ...open, status: "offered" as const, invited: true };
    expect(dueEvent(offered, T0 + OPEN_TTL_MS)).toBeNull();
    expect(dueEvent(offered, T0 + OFFER_TTL_MS)).toEqual({ kind: "expire" });
  });
});
