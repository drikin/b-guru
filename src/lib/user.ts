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

/**
 * Batch-resolve emails to user_ids in ONE query.
 *
 * `emailToUserId` is a per-row round-trip; calling it inside a row mapper turns
 * a 100-post timeline into 100 extra queries (N+1). Callers that map a list of
 * rows must resolve the whole set up front with this and pass the map down.
 *
 * Emails with no `users` row are simply absent from the map — callers decide
 * the fallback (the DTOs use `''` so the client can treat it as "no profile").
 */
export async function emailToUserIds(
  emails: (string | null | undefined)[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [
    ...new Set(
      emails
        .filter((e): e is string => !!e)
        .map((e) => e.trim().toLowerCase())
    ),
  ];
  if (uniq.length === 0) return out;
  const r = await pool.query(
    `SELECT email, user_id FROM users WHERE email = ANY($1::text[])`,
    [uniq]
  );
  for (const row of r.rows as { email: string; user_id: string }[]) {
    out.set(row.email, row.user_id);
  }
  return out;
}

/**
 * Resolve a URL path segment to an email, or null when it cannot be resolved.
 *
 * The canonical public identifier is the opaque user_id (`#/user/<user_id>`).
 * Legacy `#/user/<email>` links still resolve so old bookmarks keep working —
 * a segment containing `@` is treated as an email, anything else is looked up
 * as a user_id.
 *
 * This is the SINGLE implementation: `/api/user/[id]` and
 * `/api/user/[id]/posts` both used to carry their own copy, which is exactly
 * how the two drifted apart.
 */
export async function resolveEmailSegment(
  segment: string
): Promise<string | null> {
  let dec: string;
  try {
    dec = decodeURIComponent(segment ?? "").trim();
  } catch {
    // Malformed percent-encoding (e.g. "%") — not a resolvable user.
    return null;
  }
  if (!dec) return null;
  if (looksLikeEmail(dec)) return dec.toLowerCase(); // legacy email URL
  return userIdToEmail(dec); // opaque public user_id (canonical)
}
