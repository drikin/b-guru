/* ☗ 将棋の時計と期限（純関数。時刻はすべて DB の now() をミリ秒で渡す）。
 *
 * 正本は DB: 手番が始まった時刻（turn_started_at）と、そのときの持ち時間の残り
 * （clock_b_ms / clock_w_ms）。残り時間は「保存値 −（now − turn_started_at）」でその都度出す。
 *
 *   ⚡ 速い（blitz）: 10 分、使い切ったら 1 手 30 秒の秒読み。
 *     - 遅延の補正: 1 手ごとに経過から最大 1 秒を差し引く（通信の往復ぶん）。
 *     - 双方が 1 手目を指すまでは時計を進めない。60 秒指さなければ中断（勝敗なし）。
 *   🐢 ゆっくり（slow）: 時間制限なし。72 時間指さなければ放置負け、24 時間で一度通知。
 *   募集は 15 分、指名は 24 時間で期限切れ。
 *   サーバが止まっていた間は時間切れにしない: 起動時に、起動時刻＋10 秒より前に来る
 *   期限は「起動時刻＋10 秒」まで延ばす（restartShift）。 */
import { sideToMove, type Side } from "./shogi-rules";

export type ShogiMode = "blitz" | "slow";
export type ShogiStatus = "open" | "offered" | "active" | "ended" | "closed";

export const BLITZ_INITIAL_MS = 10 * 60_000;
export const BLITZ_BYOYOMI_MS = 30_000;
export const LAG_COMP_MS = 1_000;
export const ABORT_MS = 60_000;
export const OPEN_TTL_MS = 15 * 60_000;
export const OFFER_TTL_MS = 24 * 3600_000;
export const ABANDON_MS = 72 * 3600_000;
export const REMIND_MS = 24 * 3600_000;
export const RESTART_GRACE_MS = 10_000;

export const TIME_CONTROLS = [
  { mode: "blitz" as const, label: "⚡ 速い", initial_ms: BLITZ_INITIAL_MS, byoyomi_ms: BLITZ_BYOYOMI_MS },
  { mode: "slow" as const, label: "🐢 ゆっくり", initial_ms: 0, byoyomi_ms: 0, abandon_ms: ABANDON_MS, remind_ms: REMIND_MS },
];

/** 時計の計算に要るだけの対局の状態（ミリ秒）。 */
export type ClockState = {
  status: ShogiStatus;
  mode: ShogiMode;
  ply: number;
  clockBMs: number;
  clockWMs: number;
  byoyomiMs: number;
  /** active のときの手番の開始時刻。 */
  turnStartedAt: number | null;
  createdAt: number;
  /** invitee あり = 指名（24 時間）、なし = 募集（15 分）。 */
  invited: boolean;
  /** ゆっくり: この手番で 24 時間の通知を送った時刻。 */
  remindedAt: number | null;
};

export function mainOf(g: ClockState, side: Side): number {
  return side === "black" ? g.clockBMs : g.clockWMs;
}

/** 経過のうち時計から引くぶん（1 手 1 秒までの遅延の補正）。 */
export function charged(elapsedMs: number): number {
  return Math.max(0, elapsedMs - LAG_COMP_MS);
}

/** 双方が 1 手目を指すまで（ply 0, 1）は時計を進めない。 */
export function clockRunning(g: Pick<ClockState, "mode" | "ply">): boolean {
  return g.mode === "blitz" && g.ply >= 2;
}

export type Spend =
  | { ok: true; spentMs: number; clockBMs: number; clockWMs: number }
  | { ok: false; reason: "timeout" | "aborted" };

/** 手番側が now に指したときの時計。時間切れ・中断ならそう返す（その手は指せない）。 */
export function spend(g: ClockState, now: number): Spend {
  const start = g.turnStartedAt ?? now;
  const elapsed = Math.max(0, now - start);
  const side = sideToMove(g.ply);
  if (g.mode === "slow") return { ok: true, spentMs: elapsed, clockBMs: g.clockBMs, clockWMs: g.clockWMs };
  if (!clockRunning(g)) {
    if (charged(elapsed) > ABORT_MS) return { ok: false, reason: "aborted" };
    return { ok: true, spentMs: elapsed, clockBMs: g.clockBMs, clockWMs: g.clockWMs };
  }
  const c = charged(elapsed);
  const main = mainOf(g, side);
  let next = main;
  if (c <= main) next = main - c;
  else if (c - main <= g.byoyomiMs) next = 0; // 秒読みの中で指した（秒読みは 1 手ごとに戻る）
  else return { ok: false, reason: "timeout" };
  return {
    ok: true,
    spentMs: elapsed,
    clockBMs: side === "black" ? next : g.clockBMs,
    clockWMs: side === "white" ? next : g.clockWMs,
  };
}

export type DueEvent =
  | { kind: "expire" }
  | { kind: "abort" }
  | { kind: "timeout"; loser: Side }
  | { kind: "abandon"; loser: Side }
  | { kind: "remind"; side: Side };

/** 次に何かが起きる時刻（タイマーを張る先）。何も起きないなら null。 */
export function nextEventAt(g: ClockState): number | null {
  if (g.status === "open" || g.status === "offered") {
    return g.createdAt + (g.invited ? OFFER_TTL_MS : OPEN_TTL_MS);
  }
  if (g.status !== "active" || g.turnStartedAt == null) return null;
  if (g.mode === "slow") {
    if (g.remindedAt == null) return g.turnStartedAt + REMIND_MS;
    return g.turnStartedAt + ABANDON_MS;
  }
  return deadlineOf(g);
}

/** 手番側が負ける（中断する）時刻。速い将棋だけ。表示にも使う。 */
export function deadlineOf(g: ClockState): number | null {
  if (g.status !== "active" || g.turnStartedAt == null) return null;
  if (g.mode === "slow") return g.turnStartedAt + ABANDON_MS;
  if (!clockRunning(g)) return g.turnStartedAt + ABORT_MS + LAG_COMP_MS;
  return g.turnStartedAt + mainOf(g, sideToMove(g.ply)) + g.byoyomiMs + LAG_COMP_MS;
}

/** now の時点で起きていること（期限切れ・中断・時間切れ・放置・通知）。なければ null。 */
export function dueEvent(g: ClockState, now: number): DueEvent | null {
  if (g.status === "open" || g.status === "offered") {
    const at = nextEventAt(g);
    return at != null && now >= at ? { kind: "expire" } : null;
  }
  if (g.status !== "active" || g.turnStartedAt == null) return null;
  const side = sideToMove(g.ply);
  if (g.mode === "slow") {
    if (now >= g.turnStartedAt + ABANDON_MS) return { kind: "abandon", loser: side };
    if (g.remindedAt == null && now >= g.turnStartedAt + REMIND_MS) return { kind: "remind", side };
    return null;
  }
  const dl = deadlineOf(g)!;
  if (now < dl) return null;
  return clockRunning(g) ? { kind: "timeout", loser: side } : { kind: "abort" };
}

/** 起動直後: 起動時刻＋猶予より前に来る期限を延ばす（止まっていた間は時間切れにしない）。
 *  新しい turn_started_at を返す（動かさなくてよいなら null）。 */
export function restartShift(g: ClockState, bootAt: number): number | null {
  if (g.status !== "active" || g.turnStartedAt == null) return null;
  const dl = deadlineOf(g);
  if (dl == null) return null;
  const floor = bootAt + RESTART_GRACE_MS;
  if (dl >= floor) return null;
  return g.turnStartedAt + (floor - dl);
}

/** 表示用: now の残り（手番側は経過を引く。秒読みに入っていれば main は 0）。 */
export function remainingAt(g: ClockState, now: number): { black_ms: number; white_ms: number; byoyomi_left_ms: number | null } {
  if (g.mode !== "blitz") return { black_ms: g.clockBMs, white_ms: g.clockWMs, byoyomi_left_ms: null };
  let b = g.clockBMs;
  let w = g.clockWMs;
  let byo: number | null = null;
  if (g.status === "active" && g.turnStartedAt != null && clockRunning(g)) {
    const side = sideToMove(g.ply);
    const c = charged(now - g.turnStartedAt);
    const main = mainOf(g, side);
    const left = main - c;
    if (left >= 0) {
      if (side === "black") b = left;
      else w = left;
    } else {
      if (side === "black") b = 0;
      else w = 0;
      byo = Math.max(0, g.byoyomiMs + left);
    }
  }
  return { black_ms: b, white_ms: w, byoyomi_left_ms: byo };
}
