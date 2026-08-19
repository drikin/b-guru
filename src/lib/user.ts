/**
 * User identity mapping: opaque public user_id <-> internal email.
 *
 * The B-guru profile timeline historically used `#/user/<email>` as its public
 * identifier, exposing member email addresses. To stop that, each email gets a
 * stable, generated, URL-safe user_id (no email info inside) that is used as
 * the public profile URL segment. The email stays the internal key everywhere
 * (auth / gravatar / posts.author_email / admin / presence / push / chat).
 *
 * `users` is the single source of truth for email <-> user_id.
 *   users(user_id TEXT PK, email TEXT UNIQUE NOT NULL, created_at timestamptz)
 *
 * New emails get a user_id lazily via ensureUserId(); existing members (who
 * already have posts/profiles) are backfilled once at deploy time from the
 * distinct emails in posts / user_profiles / sessions (see backfill SQL).
 */
import { pool } from "./db";

const ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const USER_ID_LEN = 12;

/** Generate a URL-safe opaque user_id. `rand` is injectable for unit tests. */
export function genUserId(rand: () => number = Math.random): string {
  let s = "";
  for (let i = 0; i < USER_ID_LEN; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  }
  return s;
}

/** True if a route segment / hash token looks like a legacy email address. */
export function looksLikeEmail(s: string): boolean {
  return typeof s === "string" && s.includes("@");
}

/** Return the stable user_id for an email, creating it idempotently. */
export async function ensureUserId(email: string): Promise<string> {
  const em = email.trim().toLowerCase();
  if (!em.includes("@")) throw new Error("ensureUserId requires an email");
  const existing = await pool.query(
    `SELECT user_id FROM users WHERE email = $1`,
    [em]
  );
  if (existing.rows[0]) return existing.rows[0].user_id as string;
  // Race-safe: INSERT ... ON CONFLICT (email) DO NOTHING, retry a few times.
  for (let attempt = 0; attempt < 4; attempt++) {
    const inserted = await pool.query(
      `INSERT INTO users (user_id, email) VALUES ($1, $2)
       ON CONFLICT (email) DO NOTHING RETURNING user_id`,
      [genUserId(), em]
    );
    if (inserted.rows[0]) return inserted.rows[0].user_id as string;
    const again = await pool.query(
      `SELECT user_id FROM users WHERE email = $1`,
      [em]
    );
    if (again.rows[0]) return again.rows[0].user_id as string;
  }
  throw new Error("user id generation failed");
}

/** Resolve a user_id to its email, or null if unknown. */
export async function userIdToEmail(userId: string): Promise<string | null> {
  if (!userId) return null;
  const r = await pool.query(`SELECT email FROM users WHERE user_id = $1`, [
    userId,
  ]);
  return r.rows[0]?.email ?? null;
}

/** Resolve an email to its user_id, or null if unknown (never creates). */
export async function emailToUserId(email: string): Promise<string | null> {
  if (!email) return null;
  const r = await pool.query(`SELECT user_id FROM users WHERE email = $1`, [
    email.trim().toLowerCase(),
  ]);
  return r.rows[0]?.user_id ?? null;
}
