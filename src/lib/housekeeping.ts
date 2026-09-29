/**
 * Periodic DB housekeeping: delete rows that can never be read again.
 *
 * - sessions: getSessionEmail() only accepts `expires_at > now()`, so expired
 *   rows are dead weight (738 of 1,055 on 2026-09-28) that nothing removed.
 * - otp_codes: the OTP login flow is gone (no reader since 2026-09-01); expired
 *   codes are likewise unreadable.
 *
 * Deliberately NOT in lib/session.ts (another workstream owns that file).
 * One process-wide timer, started from instrumentation.ts. Idempotent, like
 * ensureChatSweeper / ensurePresenceSweeper.
 */
import { pool } from "./db";

const INTERVAL_MS = 60 * 60 * 1000; // hourly — expired rows are harmless, just clutter

export async function purgeExpiredAuthRows(): Promise<{ sessions: number; otp: number }> {
  const s = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  const o = await pool.query(`DELETE FROM otp_codes WHERE expires_at < now()`);
  return { sessions: s.rowCount ?? 0, otp: o.rowCount ?? 0 };
}

let started = false;
export function ensureHousekeeping(): void {
  if (started) return;
  started = true;
  const run = () =>
    purgeExpiredAuthRows()
      .then((r) => {
        if (r.sessions || r.otp) console.log(`[bsm] housekeeping: -${r.sessions} sessions, -${r.otp} otp`);
      })
      .catch((e) => console.error("[bsm] housekeeping error:", (e as Error)?.message));
  run();
  setInterval(run, INTERVAL_MS).unref?.();
}
