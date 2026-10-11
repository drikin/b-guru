/* since_id ポーリング: 「その投稿より last_activity が新しい投稿」を新しい順に返す。
 * REST /api/agent/posts と MCP get_posts の両方から使用（SQL 重複の単一正本化）。 */
import { pool } from "@/lib/db";
import { POST_SELECT, mapRow, type FeedPost } from "@/lib/posts";
import type { AgentContext } from "@/lib/agent-auth";

export async function listPostsSince(
  ctx: AgentContext,
  sinceId: number,
  limit: number,
  hiddenClubs: string[]
): Promise<FeedPost[]> {
  const params: unknown[] = [sinceId, ctx.email, limit];
  const laExpr = `GREATEST(p.created_at, COALESCE((SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = p.id AND r.is_whisper IS NOT TRUE), p.created_at))`;
  const hiddenSql =
    hiddenClubs.length > 0
      ? ` AND (p.club IS NULL OR p.club NOT IN (${hiddenClubs
          .map((_, i) => `$${params.length + 1 + i}`)
          .join(",")}))`
      : "";
  if (hiddenClubs.length > 0) params.push(...hiddenClubs);
  const r = await pool.query(
    `SELECT ${POST_SELECT}
       WHERE p.parent_id IS NULL AND p.is_whisper IS NOT TRUE
         AND ${laExpr} > (SELECT ${laExpr} FROM posts p2 WHERE p2.id = $1)
         ${hiddenSql}
       ORDER BY ${laExpr} DESC
       LIMIT $3`,
    params
  );
  return r.rows.map(mapRow);
}
