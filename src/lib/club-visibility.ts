import { pool } from "./db";

/** Per-user club visibility (drikin 2026-10-02). Absence of a row = visible;
 *  only hidden clubs get a row. Server-persisted so the setting syncs across
 *  devices. NOT the clubs.active flag — that hides a club for everyone. */

/** Return the set of club keys this user has hidden. */
export async function getHiddenClubs(email: string): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT club_key FROM club_visibility WHERE email = $1 AND hidden = TRUE`,
    [email]
  );
  return new Set(res.rows.map((r) => r.club_key));
}

/** Toggle one club's visibility for this user. Returns the new hidden state. */
export async function setClubHidden(
  email: string,
  clubKey: string,
  hidden: boolean
): Promise<boolean> {
  if (hidden) {
    await pool.query(
      `INSERT INTO club_visibility (email, club_key, hidden) VALUES ($1, $2, TRUE)
       ON CONFLICT (email, club_key) DO UPDATE SET hidden = TRUE, updated_at = now()`,
      [email, clubKey]
    );
  } else {
    // Absence means visible — delete the row so the table stays small.
    await pool.query(
      `DELETE FROM club_visibility WHERE email = $1 AND club_key = $2`,
      [email, clubKey]
    );
  }
  return hidden;
}
