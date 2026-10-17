import { pool } from "./db";

/** Per-user club pins (snize 2026-10-17): pinned clubs stay at the top of the
 *  sidebar / mobile club bar in pin order instead of moving with activity.
 *  Absence of a row = not pinned (unpin deletes the row), same as
 *  club_visibility. Independent of the eye toggle — a club can be both. */

/** Return this user's pinned club keys, oldest pin first. */
export async function getPinnedClubs(email: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT club_key FROM club_pins WHERE email = $1 ORDER BY pinned_at, club_key`,
    [email]
  );
  return res.rows.map((r) => r.club_key);
}

/** Pin or unpin one club for this user. Re-pinning keeps the original order. */
export async function setClubPinned(
  email: string,
  clubKey: string,
  pinned: boolean
): Promise<boolean> {
  if (pinned) {
    await pool.query(
      `INSERT INTO club_pins (email, club_key) VALUES ($1, $2)
       ON CONFLICT (email, club_key) DO NOTHING`,
      [email, clubKey]
    );
  } else {
    await pool.query(`DELETE FROM club_pins WHERE email = $1 AND club_key = $2`, [
      email,
      clubKey,
    ]);
  }
  return pinned;
}
