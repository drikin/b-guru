/* Apple Push Notification service (token-based auth, HTTP/2) — no dependencies,
 * just node:http2 + node:crypto.
 *
 * Config (production .env; the .p8 keys never go in the repo). Apple's current
 * team keys are tied to ONE environment, so there are two sets:
 *   APNS_KEY_PATH / APNS_KEY_ID                  production (TestFlight, App Store)
 *   APNS_SANDBOX_KEY_PATH / APNS_SANDBOX_KEY_ID  sandbox (Xcode builds, simulator)
 *     (…_KEY instead of …_KEY_PATH = the PEM text itself; a sandbox set is optional —
 *      without it, sandbox devices use the production key, which works for older
 *      keys valid in both environments)
 *   APNS_TEAM_ID    10-char Team ID (default F9349EVF2K)
 *   APNS_TOPIC      bundle id (default fm.backspace.bguru.chat)
 * Without a key, sending is disabled and every call is a no-op — so this code can
 * ship before the key is installed without changing production behaviour. */
import http2 from "http2";
import crypto from "crypto";
import { readFileSync } from "fs";

export type ApnsEnvironment = "production" | "sandbox";

export interface ApnsConfig {
  keyPem: string;
  keyId: string;
  teamId: string;
  topic: string;
}

export interface ApnsResult {
  status: number; // HTTP status (0 = transport error / disabled)
  reason?: string; // APNs reason, e.g. "BadDeviceToken", "Unregistered"
}

const HOSTS: Record<ApnsEnvironment, string> = {
  production: "https://api.push.apple.com",
  sandbox: "https://api.sandbox.push.apple.com",
};

export const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/i;

const cachedConfig = new Map<ApnsEnvironment, ApnsConfig | null>();

export function apnsConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
  environment: ApnsEnvironment = "production"
): ApnsConfig | null {
  const p = environment === "sandbox" && (env.APNS_SANDBOX_KEY || env.APNS_SANDBOX_KEY_PATH) ? "APNS_SANDBOX_" : "APNS_";
  let keyPem = env[`${p}KEY`] ?? "";
  const keyPath = env[`${p}KEY_PATH`];
  if (!keyPem && keyPath) {
    try {
      keyPem = readFileSync(/*turbopackIgnore: true*/ keyPath, "utf8");
    } catch {
      keyPem = "";
    }
  }
  const keyId = (env[`${p}KEY_ID`] ?? "").trim();
  if (!keyPem.includes("PRIVATE KEY") || !/^[A-Z0-9]{10}$/.test(keyId)) return null;
  return {
    keyPem,
    keyId,
    teamId: (env.APNS_TEAM_ID ?? "F9349EVF2K").trim(),
    topic: (env.APNS_TOPIC ?? "fm.backspace.bguru.chat").trim(),
  };
}

function config(environment: ApnsEnvironment): ApnsConfig | null {
  if (!cachedConfig.has(environment)) cachedConfig.set(environment, apnsConfigFromEnv(process.env, environment));
  return cachedConfig.get(environment) ?? null;
}

/** Any key configured (production or sandbox). */
export function apnsEnabled(): boolean {
  return config("production") !== null || config("sandbox") !== null;
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** ES256 provider token. Apple wants it refreshed every 20–60 minutes. */
export function makeProviderToken(cfg: ApnsConfig, iatSec: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: cfg.keyId }));
  const claims = b64url(JSON.stringify({ iss: cfg.teamId, iat: iatSec }));
  const data = `${header}.${claims}`;
  // JWS needs the raw r||s form, not DER — hence ieee-p1363.
  const sig = crypto.sign("sha256", Buffer.from(data), { key: cfg.keyPem, dsaEncoding: "ieee-p1363" });
  return `${data}.${b64url(sig)}`;
}

const jwts = new Map<string, { token: string; iat: number }>(); // per key id
function providerToken(cfg: ApnsConfig): string {
  const now = Math.floor(Date.now() / 1000);
  const j = jwts.get(cfg.keyId);
  if (j && now - j.iat <= 50 * 60) return j.token;
  const fresh = { token: makeProviderToken(cfg, now), iat: now };
  jwts.set(cfg.keyId, fresh);
  return fresh.token;
}

// One long-lived HTTP/2 connection per environment (Apple asks to reuse them).
const sessions = new Map<ApnsEnvironment, http2.ClientHttp2Session>();
function session(env: ApnsEnvironment): http2.ClientHttp2Session {
  const existing = sessions.get(env);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const s = http2.connect(HOSTS[env]);
  const drop = () => {
    if (sessions.get(env) === s) sessions.delete(env);
  };
  s.on("error", drop);
  s.on("close", drop);
  s.on("goaway", drop);
  s.setTimeout(60 * 60 * 1000, () => s.close()); // idle an hour → reconnect next time
  s.unref?.();
  sessions.set(env, s);
  return s;
}

/** Send one notification. Never throws. */
export async function sendApns(
  deviceToken: string,
  environment: ApnsEnvironment,
  payload: object,
  opts: { collapseId?: string; pushType?: "alert" | "background"; expirationSec?: number } = {}
): Promise<ApnsResult> {
  const cfg = config(environment);
  if (!cfg) return { status: 0, reason: "disabled" };
  if (!APNS_TOKEN_RE.test(deviceToken)) return { status: 400, reason: "BadDeviceToken" };
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 4096) return { status: 413, reason: "PayloadTooLarge" };

  return new Promise<ApnsResult>((resolve) => {
    let done = false;
    const finish = (r: ApnsResult) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const headers: http2.OutgoingHttpHeaders = {
        ":method": "POST",
        ":path": `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken(cfg)}`,
        "apns-topic": cfg.topic,
        "apns-push-type": opts.pushType ?? "alert",
        "apns-priority": opts.pushType === "background" ? "5" : "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + (opts.expirationSec ?? 3600)),
        "content-type": "application/json",
      };
      if (opts.collapseId) headers["apns-collapse-id"] = opts.collapseId.slice(0, 64);
      const req = session(environment).request(headers);
      let status = 0;
      let raw = "";
      req.setEncoding("utf8");
      req.on("response", (h) => {
        status = Number(h[":status"] ?? 0);
      });
      req.on("data", (c: string) => {
        raw += c;
      });
      req.on("end", () => {
        let reason: string | undefined;
        try {
          reason = raw ? JSON.parse(raw).reason : undefined;
        } catch {
          /* empty body on 200 */
        }
        finish({ status, reason });
      });
      req.on("error", (e) => finish({ status: 0, reason: e.message }));
      req.setTimeout(10_000, () => {
        req.close();
        finish({ status: 0, reason: "timeout" });
      });
      req.end(body);
    } catch (e) {
      finish({ status: 0, reason: (e as Error).message });
    }
  });
}

/** The device token is gone for good (app deleted, wrong environment, …). */
export function isDeadToken(r: ApnsResult): boolean {
  return r.status === 410 || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(r.reason ?? "");
}

/** Tests only. */
export function __resetApnsForTests(cfg?: ApnsConfig | null) {
  cachedConfig.clear();
  if (cfg !== undefined) {
    cachedConfig.set("production", cfg);
    cachedConfig.set("sandbox", cfg);
  }
  jwts.clear();
  for (const s of sessions.values()) s.destroy();
  sessions.clear();
}
