/* Firebase Cloud Messaging (HTTP v1) for the Android app — no dependencies,
 * just fetch + node:crypto.
 *
 * Config (production .env; the service-account key never goes in the repo):
 *   FCM_SERVICE_ACCOUNT_PATH  the JSON key of a service account with the
 *                             "Firebase Cloud Messaging API Admin" role
 *   (FCM_SERVICE_ACCOUNT = the JSON text itself, instead of a path)
 * Without it, sending is disabled and every call is a no-op.
 *
 * Messages are data-only (ids, never the text): the app fetches the message with
 * its own token and shows the notification itself — the Android twin of the iOS
 * Notification Service Extension. */
import crypto from "crypto";
import { readFileSync } from "fs";

export interface FcmConfig {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

export interface FcmResult {
  status: number; // HTTP status (0 = transport error / disabled)
  reason?: string; // FCM error code, e.g. "UNREGISTERED"
}

/** FCM registration tokens: long, URL-safe base64 with ':' (no fixed format). */
export const FCM_TOKEN_RE = /^[A-Za-z0-9_:\-]{100,4096}$/;

let cachedConfig: FcmConfig | null | undefined;

export function fcmConfigFromEnv(env: Record<string, string | undefined> = process.env): FcmConfig | null {
  let raw = env.FCM_SERVICE_ACCOUNT ?? "";
  if (!raw && env.FCM_SERVICE_ACCOUNT_PATH) {
    try {
      raw = readFileSync(/*turbopackIgnore: true*/ env.FCM_SERVICE_ACCOUNT_PATH, "utf8");
    } catch {
      raw = "";
    }
  }
  try {
    const j = JSON.parse(raw);
    const projectId = String(j.project_id ?? "").trim();
    const clientEmail = String(j.client_email ?? "").trim();
    const privateKey = String(j.private_key ?? "");
    if (!/^[a-z0-9-]{4,40}$/.test(projectId) || !clientEmail.includes("@") || !privateKey.includes("PRIVATE KEY")) return null;
    return { projectId, clientEmail, privateKey };
  } catch {
    return null;
  }
}

function config(): FcmConfig | null {
  if (cachedConfig === undefined) cachedConfig = fcmConfigFromEnv();
  return cachedConfig;
}

export function fcmEnabled(): boolean {
  return config() !== null;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** RS256 assertion for Google's OAuth token endpoint (service-account flow). */
export function makeAssertion(cfg: FcmConfig, iatSec: number): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: cfg.clientEmail,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: iatSec,
      exp: iatSec + 3600,
    })
  );
  const data = `${header}.${claims}`;
  const sig = crypto.sign("sha256", Buffer.from(data), cfg.privateKey);
  return `${data}.${b64url(sig)}`;
}

let access: { token: string; until: number } | null = null;
let pending: Promise<string | null> | null = null;

/** OAuth access token (valid 1 h; refreshed after 50 min). One request at a time. */
async function accessToken(cfg: FcmConfig): Promise<string | null> {
  if (access && Date.now() < access.until) return access.token;
  if (pending) return pending;
  pending = (async () => {
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: makeAssertion(cfg, Math.floor(Date.now() / 1000)),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error("[fcm] token", res.status);
        return null;
      }
      const j = (await res.json()) as { access_token?: string };
      if (!j.access_token) return null;
      access = { token: j.access_token, until: Date.now() + 50 * 60 * 1000 };
      return access.token;
    } catch (e) {
      console.error("[fcm] token", (e as Error).message);
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Data values must be strings in FCM. */
export function toFcmData(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (k === "aps" || v === undefined || v === null) continue;
    out[k] = String(v);
  }
  return out;
}

/** Send one data message. Never throws. */
export async function sendFcm(
  deviceToken: string,
  data: Record<string, string>,
  opts: { collapseKey?: string; ttlSec?: number; priority?: "HIGH" | "NORMAL" } = {}
): Promise<FcmResult> {
  const cfg = config();
  if (!cfg) return { status: 0, reason: "disabled" };
  if (!FCM_TOKEN_RE.test(deviceToken)) return { status: 400, reason: "INVALID_ARGUMENT" };
  const token = await accessToken(cfg);
  if (!token) return { status: 0, reason: "auth" };
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${cfg.projectId}/messages:send`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          data,
          android: {
            // High priority so the app may wake and post the notification at once
            // (NORMAL for messages that show nothing, e.g. read_sync: Android demotes apps whose HIGH shows nothing).
            priority: opts.priority ?? "HIGH",
            ttl: `${opts.ttlSec ?? 3600}s`,
            ...(opts.collapseKey ? { collapse_key: opts.collapseKey.slice(0, 64) } : {}),
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: 200 };
    let reason: string | undefined;
    try {
      const j = (await res.json()) as {
        error?: { status?: string; details?: { "@type"?: string; errorCode?: string }[] };
      };
      reason = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 401) access = null; // token revoked/expired early → fetch a new one next time
    return { status: res.status, reason };
  } catch (e) {
    return { status: 0, reason: (e as Error).message };
  }
}

/** The registration token is gone for good (app uninstalled, token rotated).
 *  Only UNREGISTERED: a bare 404 (wrong project id) or INVALID_ARGUMENT (bad
 *  payload) is our mistake and must never wipe members' devices. */
export function isDeadFcmToken(r: FcmResult): boolean {
  return r.reason === "UNREGISTERED";
}

/** Tests only. */
export function __resetFcmForTests(cfg?: FcmConfig | null) {
  cachedConfig = cfg;
  access = null;
  pending = null;
}
