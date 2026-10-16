/* Native-app push devices (APNs tokens for iPhone/iPad, FCM tokens for Android —
 * environment "fcm"; the column is still called apns_token), owned by an agent token. A device only
 * receives pushes while its agent token is valid (not revoked, not expired), so
 * signing out or revoking a device in /settings/agent stops its pushes at once. */
import { pool } from "./db";
import { APNS_TOKEN_RE, type ApnsEnvironment } from "./apns";
import { FCM_TOKEN_RE } from "./fcm";

export type PushEnvironment = ApnsEnvironment | "fcm";

export type NotifyMode = "all" | "mentions";

export interface PushDevice {
  email: string;
  apnsToken: string;
  environment: PushEnvironment;
  notifyMode: NotifyMode;
  quietHours: boolean;
}

export function normalizeNotifyMode(v: unknown): NotifyMode {
  return v === "mentions" ? "mentions" : "all";
}

export function normalizeEnvironment(v: unknown): PushEnvironment | null {
  return v === "production" || v === "sandbox" || v === "fcm" ? v : null;
}

/** Token format check per environment. APNs tokens are hex (stored lower-case);
 *  FCM tokens are case-sensitive and stored as-is. */
export function validPushToken(token: string, environment: PushEnvironment): boolean {
  return environment === "fcm" ? FCM_TOKEN_RE.test(token) : APNS_TOKEN_RE.test(token);
}

export function storedPushToken(token: string, environment: PushEnvironment): string {
  return environment === "fcm" ? token : token.toLowerCase();
}

export async function registerPushDevice(input: {
  email: string;
  agentTokenId: number;
  apnsToken: string;
  environment: PushEnvironment;
  platform?: string;
  notifyMode?: NotifyMode;
  quietHours?: boolean;
}): Promise<void> {
  if (!validPushToken(input.apnsToken, input.environment)) throw new Error("invalid_token");
  const email = input.email.trim().toLowerCase();
  const apnsToken = storedPushToken(input.apnsToken, input.environment);
  // One device per agent token: an app install re-registering (new APNs token
  // after a restore, etc.) replaces its own previous row instead of piling up.
  await pool.query(`DELETE FROM push_devices WHERE agent_token_id = $1 AND apns_token <> $2`, [
    input.agentTokenId,
    apnsToken,
  ]);
  // A device token belongs to one install. It may move to another member only
  // when the previous owner's agent token is no longer valid (they signed out
  // on that shared iPad) — never away from a member who is still signed in.
  await pool.query(
    `INSERT INTO push_devices (email, agent_token_id, apns_token, environment, platform, notify_mode, quiet_hours)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (apns_token) DO UPDATE SET
       email = EXCLUDED.email, agent_token_id = EXCLUDED.agent_token_id,
       environment = EXCLUDED.environment, platform = EXCLUDED.platform,
       notify_mode = EXCLUDED.notify_mode, quiet_hours = EXCLUDED.quiet_hours, updated_at = now()
     WHERE push_devices.email = EXCLUDED.email
        OR NOT EXISTS (SELECT 1 FROM agent_tokens t WHERE t.id = push_devices.agent_token_id
                        AND t.revoked_at IS NULL AND t.expires_at > now())`,
    [email, input.agentTokenId, apnsToken, input.environment, input.platform ?? "ios",
     input.notifyMode ?? "all", input.quietHours ?? true]
  );
  // At most MAX_DEVICES_PER_EMAIL devices per member (oldest go first).
  await pool.query(
    `DELETE FROM push_devices WHERE email = $1 AND id NOT IN
       (SELECT id FROM push_devices WHERE email = $1 ORDER BY updated_at DESC LIMIT $2)`,
    [email, MAX_DEVICES_PER_EMAIL]
  );
}

export const MAX_DEVICES_PER_EMAIL = 10;

/** Members who have at least one push device with a valid agent token. */
export async function pushDeviceOwners(): Promise<string[]> {
  const res = await pool.query(
    `SELECT DISTINCT d.email FROM push_devices d
       JOIN agent_tokens t ON t.id = d.agent_token_id
      WHERE t.revoked_at IS NULL AND t.expires_at > now()`
  );
  return res.rows.map((r: { email: string }) => r.email);
}

/** Either token kind: APNs tokens are stored lower-case, FCM tokens as-is. */
export async function unregisterPushDevice(email: string, token: string): Promise<void> {
  await pool.query(`DELETE FROM push_devices WHERE email = $1 AND apns_token IN ($2, $3)`, [
    email.trim().toLowerCase(),
    token,
    token.toLowerCase(),
  ]);
}

/** `token` exactly as stored (from activePushDevices). */
export async function removePushDevice(token: string): Promise<void> {
  await pool.query(`DELETE FROM push_devices WHERE apns_token = $1`, [token]);
}

/** Devices whose agent token is still valid. `emails` null = everyone with a device. */
export async function activePushDevices(emails: string[] | null): Promise<PushDevice[]> {
  const res = await pool.query(
    `SELECT d.email, d.apns_token, d.environment, d.notify_mode, d.quiet_hours
       FROM push_devices d
       JOIN agent_tokens t ON t.id = d.agent_token_id
      WHERE t.revoked_at IS NULL AND t.expires_at > now()
        AND ($1::text[] IS NULL OR d.email = ANY($1::text[]))`,
    [emails ? emails.map((e) => e.trim().toLowerCase()) : null]
  );
  return res.rows.map(
    (r: { email: string; apns_token: string; environment: string; notify_mode: string; quiet_hours: boolean }) => ({
      email: r.email,
      apnsToken: r.apns_token,
      environment: r.environment === "sandbox" ? "sandbox" : r.environment === "fcm" ? "fcm" : "production",
      notifyMode: normalizeNotifyMode(r.notify_mode),
      quietHours: r.quiet_hours !== false,
    })
  );
}

export async function markPushSent(apnsTokens: string[]): Promise<void> {
  if (apnsTokens.length === 0) return;
  await pool.query(`UPDATE push_devices SET last_sent_at = now() WHERE apns_token = ANY($1::text[])`, [apnsTokens]);
}
