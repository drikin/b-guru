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
  // POST_SELECT は $1 を見ている人のメールとして使う（2026-10-28 まで $1 が sinceId で、SQL も
  // 「SELECT SELECT」・GROUP BY なしで毎回失敗していた）。
  const params: unknown[] = [ctx.email, sinceId, limit];
  const la = (t: string) =>
    `GREATEST(${t}.created_at, COALESCE((SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = ${t}.id AND r.is_whisper IS NOT TRUE), ${t}.created_at))`;
  const laExpr = la("p");
  // 自分の投稿は非表示の部活でも出す（2026-10-28）。
  const hiddenSql =
    hiddenClubs.length > 0
      ? ` AND (p.club IS NULL OR p.author_email = $1 OR p.club NOT IN (${hiddenClubs
          .map((_, i) => `$${params.length + 1 + i}`)
          .join(",")}))`
      : "";
  if (hiddenClubs.length > 0) params.push(...hiddenClubs);
  const r = await pool.query(
    `${POST_SELECT}
       WHERE p.parent_id IS NULL AND p.is_whisper IS NOT TRUE
         AND ${laExpr} > (SELECT ${la("p2")} FROM posts p2 WHERE p2.id = $2)
         ${hiddenSql}
       GROUP BY p.id
       ORDER BY ${laExpr} DESC
       LIMIT $3`,
    params
  );
  return r.rows.map(mapRow);
}
