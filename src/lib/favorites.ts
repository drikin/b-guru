import { pool } from "./db";
import { ensureUserId, emailToUserId, userIdToEmail } from "./user";

/** お気に入り（viewer が特定の投稿者を追跡）。Instagram の「お気に入り」と同様、
 *  viewer 個人の状態で他ユーザーに影響しない（SSE ブロードキャスト対象外）。
 *  Server-persisted でデバイス間同期。email は内部キー、API は user_id でやり取り。 */

/** Normalize an email the same way posts.author_email is stored. */
function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Return the set of author emails this viewer has favorited. */
export async function getFavoriteEmails(viewerEmail: string): Promise<Set<string>> {
  const res = await pool.query(
    `SELECT author_email FROM user_favorite_authors WHERE viewer_email = $1`,
    [normEmail(viewerEmail)]
  );
  return new Set(res.rows.map((r) => r.author_email as string));
}

/** True if the viewer favorited this author. */
export async function isFavorite(viewerEmail: string, authorEmail: string): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM user_favorite_authors WHERE viewer_email = $1 AND author_email = $2 LIMIT 1`,
    [normEmail(viewerEmail), normEmail(authorEmail)]
  );
  return res.rows.length > 0;
}

/** Add an author to the viewer's favorites (idempotent). Returns the final state (true). */
export async function addFavorite(viewerEmail: string, authorEmail: string): Promise<boolean> {
  await pool.query(
    `INSERT INTO user_favorite_authors (viewer_email, author_email) VALUES ($1, $2)
     ON CONFLICT (viewer_email, author_email) DO NOTHING`,
    [normEmail(viewerEmail), normEmail(authorEmail)]
  );
  return true;
}

/** Remove an author from the viewer's favorites (idempotent). Returns the final state (false). */
export async function removeFavorite(viewerEmail: string, authorEmail: string): Promise<boolean> {
  await pool.query(
    `DELETE FROM user_favorite_authors WHERE viewer_email = $1 AND author_email = $2`,
    [normEmail(viewerEmail), normEmail(authorEmail)]
  );
  return false;
}

/** List the viewer's favorited authors as opaque user_ids (emails NEVER leave
 *  the server). Newest first. Unknown-to-users-table emails are skipped (they
 *  cannot be rendered as a profile link anyway). */
export async function listFavoriteIds(viewerEmail: string): Promise<string[]> {
  const res = await pool.query(
    `SELECT f.author_email, u.user_id
     FROM user_favorite_authors f
     LEFT JOIN users u ON u.email = f.author_email
     WHERE f.viewer_email = $1
     ORDER BY f.created_at DESC`,
    [normEmail(viewerEmail)]
  );
  return res.rows.map((r) => r.user_id).filter((id: string | null): id is string => !!id);
}

/** Resolve an opaque public user_id to an author email (for POST/DELETE). */
export async function favoriteAuthorEmailFromUserId(userId: string): Promise<string | null> {
  return userIdToEmail(userId);
}

/** Resolve an author email to its opaque public user_id (for the created notification). */
export async function favoriteAuthorIdFromEmail(email: string): Promise<string | null> {
  return emailToUserId(email);
}

/** ensureUserId re-export so route handlers only need this module. */
export { ensureUserId };
