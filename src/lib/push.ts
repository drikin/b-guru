/* Web Push (Push API) support: subscription persistence + fire-and-forget send.
 *
 * VAPID keys are read from env (WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY) so
 * they never end up in the public GitHub repo. The public key is served to the
 * client (via GET /api/push/vapid-public-key) so the browser can subscribe.
 *
 * Push is initiated from /api/publish (and friends) and is deliberately
 * fire-and-forget — the publish route never awaits the delivery.
 */
import { pool } from "./db";
import * as webPush from "web-push";

let vapidInitialized = false;

function getSubject(): string {
  return process.env.WEB_PUSH_SUBJECT || "mailto:postmaster@backspace.fm";
}

function ensureVapid(): boolean {
  const pub = process.env.WEB_PUSH_PUBLIC_KEY;
  const priv = process.env.WEB_PUSH_PRIVATE_KEY;
  if (!pub || !priv) return false;
  if (!vapidInitialized) {
    webPush.setVapidDetails(getSubject(), pub, priv);
    vapidInitialized = true;
  }
  return true;
}

/** The VAPID public key a browser needs to subscribe. */
export function getVapidPublicKey(): string | null {
  return process.env.WEB_PUSH_PUBLIC_KEY ?? null;
}

export interface PushSubscriptionRow {
  id: number;
  email: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
}

/** Upsert a browser push subscription for a member. One per (email, endpoint). */
export async function savePushSubscription(
  email: string,
  endpoint: string,
  p256dh: string,
  auth: string,
  userAgent?: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO push_subscriptions (email, endpoint, p256dh, auth, user_agent)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (email, endpoint) DO UPDATE SET
       p256dh = EXCLUDED.p256dh,
       auth = EXCLUDED.auth,
       user_agent = EXCLUDED.user_agent,
       updated_at = now()`,
    [email, endpoint, p256dh, auth, userAgent ?? null]
  );
}

export async function deletePushSubscription(email: string, endpoint: string): Promise<void> {
  await pool.query(`DELETE FROM push_subscriptions WHERE email = $1 AND endpoint = $2`, [
    email,
    endpoint,
  ]);
}

/** All saved subscriptions, optionally excluding one member (e.g. the author). */
async function listPushSubscriptions(excludeEmail?: string): Promise<PushSubscriptionRow[]> {
  const params: string[] = [];
  let where = "";
  if (excludeEmail) {
    params.push(excludeEmail);
    where = `WHERE email <> $1`;
  }
  const res = await pool.query(
    `SELECT id, email, endpoint, p256dh, auth, user_agent FROM push_subscriptions ${where}`,
    params
  );
  return res.rows;
}

/**
 * Fire-and-forget push notification to every saved subscription.
 * Endpoints that return 404/410 (subscription gone) are dropped from the DB.
 * Never throws — safe to call without awaiting.
 */
export async function sendWebPush(input: {
  title: string;
  body: string;
  url: string;
  excludeEmail?: string;
}): Promise<void> {
  if (!ensureVapid()) return; // VAPID not configured → Push not active
  const subs = await listPushSubscriptions(input.excludeEmail);
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title: input.title, body: input.body, url: input.url });

  for (const s of subs) {
    try {
      await webPush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      );
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) {
        // Subscription no longer valid — clean it up.
        try {
          await deletePushSubscription(s.email, s.endpoint);
        } catch {}
      } else {
        // Network / rate-limit / 403 (VAPID issue spans all subs) — keep & retry later.
        console.error(`webpush send failed (${s.email}) status=${code}:`, (e as any)?.message);
      }
    }
  }
}
