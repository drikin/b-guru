/* ビーグルエージェント: 自律スケジュールの検証（next_activity_at のガード）
 *  - 最小クールダウン: now + 15 分（連射防止）
 *  - watchdog: now + 6h を超えない（沈黙防止）
 *  - ハードリミット: JST で 05:00-翌02:00 の外はクランプ（暴走防止）
 *  - フォールバック: 不正/無しは now + 30 分
 */
const COOLDOWN_MS = 15 * 60 * 1000;
const WATCHDOG_MS = 6 * 60 * 60 * 1000;
const MAX_EXTRA_OK = 2 * 24 * 3600 * 1000; // クランプ探索の上限

/** JST の時（JST は DST なしの +9 固定）。 */
function jstHour(d: Date): number {
  return (d.getUTCHours() + 9) % 24;
}

/** 許可 JST 帯: 05:00〜23:59 と 翌00:00〜02:00（すなわち時 [5..23] と [0,1]）。 */
function allowedJstHour(h: number): boolean {
  return h >= 5 || h <= 1;
}

export function normalizeNextActivityAt(
  proposed: string | null,
  now: Date = new Date()
): Date {
  const fallback = new Date(now.getTime() + 30 * 60 * 1000);

  let t: Date;
  if (!proposed) return fallback;
  const parsed = new Date(proposed);
  if (isNaN(parsed.getTime())) return fallback;
  t = parsed;

  // クールダウン
  const minNext = new Date(now.getTime() + COOLDOWN_MS);
  if (t.getTime() < minNext.getTime()) t = minNext;
  // watchdog
  const maxNext = new Date(now.getTime() + WATCHDOG_MS);
  if (t.getTime() > maxNext.getTime()) t = maxNext;

  // ハードリミット（JST 帯）にクランプ
  let guard = 0;
  while (!allowedJstHour(jstHour(t)) && guard++ < MAX_EXTRA_OK) {
    t = new Date(t.getTime() + 60 * 60 * 1000);
  }
  return t;
}
