import { pool } from "./db";

/** ブックマーク（viewer が気になった投稿を保存）。Instagram の「保存」と同じ
 *  概念: 投稿単位・viewer 個人の状態で他ユーザーに影響しない（SSE 対象外）。
 *  ☆お気に入り（人を追跡・favorites.ts）と 🔖ブックマーク（投稿を保存）は別概念。
 *  email 規約は favorites.ts の normEmail と同一（trim + lowercase）。
 *  post_id は FK ON DELETE CASCADE — 投稿削除で行も消える。 */

function normEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Return the set of post ids this viewer has bookmarked (newest first). */
export async function getBookmarkedPostIds(viewerEmail: string): Promise<number[]> {
  const res = await pool.query(
    `SELECT post_id FROM user_post_bookmarks WHERE viewer_email = $1 ORDER BY created_at DESC`,
    [normEmail(viewerEmail)]
  );
  return res.rows.map((r) => Number(r.post_id));
}

/** True if the viewer bookmarked this post. */
export async function isBookmarked(viewerEmail: string, postId: number): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM user_post_bookmarks WHERE viewer_email = $1 AND post_id = $2 LIMIT 1`,
    [normEmail(viewerEmail), postId]
  );
  return res.rows.length > 0;
}

/** Bookmark a post (idempotent). Returns the final state (true). */
export async function addBookmark(viewerEmail: string, postId: number): Promise<boolean> {
  await pool.query(
    `INSERT INTO user_post_bookmarks (viewer_email, post_id) VALUES ($1, $2)
     ON CONFLICT (viewer_email, post_id) DO NOTHING`,
    [normEmail(viewerEmail), postId]
  );
  return true;
}

/** Un-bookmark a post (idempotent). Returns the final state (false). */
export async function removeBookmark(viewerEmail: string, postId: number): Promise<boolean> {
  await pool.query(
    `DELETE FROM user_post_bookmarks WHERE viewer_email = $1 AND post_id = $2`,
    [normEmail(viewerEmail), postId]
  );
  return false;
}
