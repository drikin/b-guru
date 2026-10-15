/* Native-app push devices (APNs tokens), owned by an agent token. A device only
 * receives pushes while its agent token is valid (not revoked, not expired), so
 * signing out or revoking a device in /settings/agent stops its pushes at once. */
import { pool } from "./db";
import { APNS_TOKEN_RE, type ApnsEnvironment } from "./apns";

export interface PushDevice {
  email: string;
  apnsToken: string;
  environment: ApnsEnvironment;
}

export function normalizeEnvironment(v: unknown): ApnsEnvironment | null {
  return v === "production" || v === "sandbox" ? v : null;
}

export async function registerPushDevice(input: {
  email: string;
  agentTokenId: number;
  apnsToken: string;
  environment: ApnsEnvironment;
  platform?: string;
}): Promise<void> {
  if (!APNS_TOKEN_RE.test(input.apnsToken)) throw new Error("invalid_token");
  // A device token belongs to one install; re-registering moves it to the
  // current owner/agent token (e.g. a different member signs in on that iPad).
  await pool.query(
    `INSERT INTO push_devices (email, agent_token_id, apns_token, environment, platform)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (apns_token) DO UPDATE SET
       email = EXCLUDED.email, agent_token_id = EXCLUDED.agent_token_id,
       environment = EXCLUDED.environment, platform = EXCLUDED.platform, updated_at = now()`,
    [input.email.trim().toLowerCase(), input.agentTokenId, input.apnsToken.toLowerCase(), input.environment, input.platform ?? "ios"]
  );
}

export async function unregisterPushDevice(email: string, apnsToken: string): Promise<void> {
  await pool.query(`DELETE FROM push_devices WHERE email = $1 AND apns_token = $2`, [
    email.trim().toLowerCase(),
    apnsToken.toLowerCase(),
  ]);
}

export async function removePushDevice(apnsToken: string): Promise<void> {
  await pool.query(`DELETE FROM push_devices WHERE apns_token = $1`, [apnsToken.toLowerCase()]);
}

/** Devices whose agent token is still valid. `emails` null = everyone with a device. */
export async function activePushDevices(emails: string[] | null): Promise<PushDevice[]> {
  const res = await pool.query(
    `SELECT d.email, d.apns_token, d.environment
       FROM push_devices d
       JOIN agent_tokens t ON t.id = d.agent_token_id
      WHERE t.revoked_at IS NULL AND t.expires_at > now()
        AND ($1::text[] IS NULL OR d.email = ANY($1::text[]))`,
    [emails ? emails.map((e) => e.trim().toLowerCase()) : null]
  );
  return res.rows.map((r: { email: string; apns_token: string; environment: string }) => ({
    email: r.email,
    apnsToken: r.apns_token,
    environment: r.environment === "sandbox" ? "sandbox" : "production",
  }));
}

export async function markPushSent(apnsTokens: string[]): Promise<void> {
  if (apnsTokens.length === 0) return;
  await pool.query(`UPDATE push_devices SET last_sent_at = now() WHERE apns_token = ANY($1::text[])`, [apnsTokens]);
}
