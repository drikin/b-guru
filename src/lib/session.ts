/* Session management: DB-backed opaque session tokens in a cookie */
import crypto from "crypto";
import { cookies } from "next/headers";
import { pool } from "./db";

const SESSION_COOKIE = "bsm_session";
/** Sliding: a session lives this long after its LAST use (see getSessionEmail),
 * so a device that keeps using B-guru never has to sign in again. */
const SESSION_TTL_SEC = 60 * 60 * 24 * 90; // 90 days
/** Extend at most once a day, not on every request. */
const SESSION_SLIDE_AFTER_SEC = 60 * 60 * 24;
/** The cookie outlives the DB row (400 days is the browsers' cap); the DB
 * `expires_at` is what decides whether the session is still valid. */
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 400;

export async function createSession(email: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO sessions (token, email, expires_at)
     VALUES ($1, $2, now() + make_interval(secs => $3))`,
    [token, email, SESSION_TTL_SEC]
  );
  return token;
}

/** Read session from cookie, returning email or null. */
export async function getSessionEmail(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await pool.query(
    `SELECT email, (expires_at < now() + make_interval(secs => $2)) AS stale
       FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token, SESSION_TTL_SEC - SESSION_SLIDE_AFTER_SEC]
  );
  if (res.rows.length === 0) return null;
  if (res.rows[0].stale) {
    // Best effort: a failed extension must not sign the user out.
    pool
      .query(
        `UPDATE sessions SET expires_at = now() + make_interval(secs => $2) WHERE token = $1`,
        [token, SESSION_TTL_SEC]
      )
      .catch(() => {});
  }
  return res.rows[0].email;
}

/** Sign one member out everywhere: every web session and every app / agent
 * token. Used by the "not me" link in the new-login email. */
export async function destroyAllSessionsFor(email: string): Promise<void> {
  const e = email.trim().toLowerCase();
  await pool.query(`DELETE FROM sessions WHERE email = $1`, [e]);
  await pool.query(
    `UPDATE agent_tokens SET revoked_at = now() WHERE email = $1 AND revoked_at IS NULL`,
    [e]
  );
}

/** Set the session cookie (call from a Route Handler). */
export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

/** Clear the session cookie + DB row (logout). */
export async function destroySession() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }
  store.delete(SESSION_COOKIE);
}
