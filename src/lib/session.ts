/* Session management: DB-backed opaque session tokens in a cookie */
import crypto from "crypto";
import { cookies } from "next/headers";
import { pool } from "./db";

const SESSION_COOKIE = "bsm_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 7; // 7 days

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
    `SELECT email FROM sessions WHERE token = $1 AND expires_at > now()`,
    [token]
  );
  if (res.rows.length === 0) return null;
  return res.rows[0].email;
}

/** Set the session cookie (call from a Route Handler). */
export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SEC,
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
