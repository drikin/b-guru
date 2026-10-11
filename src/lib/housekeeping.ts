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

export async function purgeExpiredAuthRows(): Promise<{
  sessions: number;
  otp: number;
  agentTokens: number;
  agentAudit: number;
}> {
  const s = await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  const o = await pool.query(`DELETE FROM otp_codes WHERE expires_at < now()`);
  // エージェントトークン: 期限切れ OR 失効から 90 日経過。監査ログは 90 日保持。
  const at = await pool.query(
    `DELETE FROM agent_tokens WHERE expires_at < now()
        OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '90 days')`
  );
  const aa = await pool.query(
    `DELETE FROM agent_audit_log WHERE created_at < now() - interval '90 days'`
  );
  return {
    sessions: s.rowCount ?? 0,
    otp: o.rowCount ?? 0,
    agentTokens: at.rowCount ?? 0,
    agentAudit: aa.rowCount ?? 0,
  };
}

let started = false;
export function ensureHousekeeping(): void {
  if (started) return;
  started = true;
  const run = () =>
    purgeExpiredAuthRows()
      .then((r) => {
        if (r.sessions || r.otp || r.agentTokens || r.agentAudit)
          console.log(
            `[bsm] housekeeping: -${r.sessions} sessions, -${r.otp} otp, -${r.agentTokens} agent tokens, -${r.agentAudit} agent audit`
          );
      })
      .catch((e) => console.error("[bsm] housekeeping error:", (e as Error)?.message));
  run();
  setInterval(run, INTERVAL_MS).unref?.();
}
