/* Shared display-name resolution: user_profiles.display_name has priority,
 * falling back to the member's most recent timeline author_name (Ghost name
 * saved at post time), then null. Used by every surface that renders a
 * member's name (timeline aliases this via SQL; chat / presence /
 * notifications resolve here at read time so profile edits propagate live).
 */
import { pool } from "./db";

/** Resolve current display names for a batch of emails (deduped).
 *  Every requested email gets an entry (null when unknown). */
export async function resolveDisplayNames(
  emails: string[]
): Promise<Map<string, string | null>> {
  const uniq = Array.from(new Set(emails.filter(Boolean)));
  const map = new Map<string, string | null>();
  for (const em of uniq) map.set(em, null);
  if (uniq.length === 0) return map;

  const res = await pool.query(
    `SELECT emails.email,
            COALESCE(
              up.display_name,
              (SELECT p.author_name FROM posts p
               WHERE p.author_email = emails.email
               ORDER BY p.created_at DESC LIMIT 1)
            ) AS name
     FROM unnest($1::text[]) AS emails(email)
     LEFT JOIN user_profiles up ON up.email = emails.email`,
    [uniq]
  );
  for (const r of res.rows) map.set(r.email, r.name);
  return map;
}

/** Resolve a single email's current display name (or null). */
export async function resolveDisplayName(
  email: string
): Promise<string | null> {
  const m = await resolveDisplayNames([email]);
  return m.get(email) ?? null;
}
