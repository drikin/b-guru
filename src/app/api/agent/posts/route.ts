/* GET /api/agent/posts — タイムライン（読み取り専用・スコープ read）。
 * cursor ページング（last_activity ベース・既存 before と同型）、limit 上限 100。
 * フィルタ: club / search / since_id / fav / bookmark。author_user_id は
 * 不透明 user_id で指定（内部で email に解決・レスポンスには email を含めない）。 */
import { NextRequest, NextResponse } from "next/server";
import { listPosts } from "@/lib/posts";
import { pool } from "@/lib/db";
import { getHiddenClubs } from "@/lib/club-visibility";
import { getFavoriteEmails } from "@/lib/favorites";
import { getBookmarkedPostIds } from "@/lib/bookmarks";
import { userIdToEmail } from "@/lib/user";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** FeedPost から email 系フィールドを除去した機械可読 DTO（生 JSON・apiVersion 付き）。 */
export function agentPostDto(p: any) {
  return {
    id: p.id,
    author_id: p.authorId,
    author_name: p.authorName ?? null,
    parent_id: p.parentId ?? null,
    reply_count: p.replyCount ?? 0,
    text: p.text,
    images: p.images ?? [],
    video_url: p.videoUrl ?? null,
    audio_url: p.audioUrl ?? null,
    url_preview: p.urlPreview ?? null,
    like_count: p.likeCount ?? 0,
    created_at: p.createdAt,
    last_activity_at: p.lastActivityAt ?? p.createdAt,
    pinned_at: p.pinnedAt ?? null,
    club: p.club ?? null,
    club_manual: !!p.clubManual,
    poll: p.poll ?? null,
  };
}

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/posts", "read", async (ctx) => {
    const sp = req.nextUrl.searchParams;
    const rawLimit = Number(sp.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const cursor = sp.get("cursor") ?? undefined;
    const club = sp.get("club") ?? undefined;
    const search = sp.get("search") ?? undefined;
    const sinceIdRaw = Number(sp.get("since_id") ?? "");
    const fav = sp.get("fav") === "1";
    const bm = sp.get("bm") === "1";
    const authorUserId = sp.get("author_user_id") ?? undefined;

    // since_id: cursor が優先。無ければ「last_activity > since_id の投稿の最終活動時刻」
    // を既存 before カーソルに変換してページング（ポーリング用途）。
    let before: string | undefined;
    if (!cursor && Number.isInteger(sinceIdRaw) && sinceIdRaw > 0) {
      const r = await pool.query(
        `SELECT GREATEST(p.created_at,
            COALESCE((SELECT MAX(r2.created_at) FROM posts r2 WHERE r2.parent_id = p.id AND r2.is_whisper IS NOT TRUE), p.created_at)
          ) AS la
           FROM posts p WHERE p.id = $1 AND p.parent_id IS NULL`,
        [sinceIdRaw]
      );
      if (r.rows.length === 0) {
        return { status: 404, body: { error: "since_id の投稿が見つかりません", code: "not_found" } };
      }
      before = new Date(r.rows[0].la).toISOString();
    }

    const authorEmail = authorUserId ? await userIdToEmail(authorUserId) : undefined;
    if (authorUserId && !authorEmail) {
      return { status: 404, body: { error: "ユーザーが見つかりません", code: "not_found" } };
    }

    const hiddenSet = !club ? await getHiddenClubs(ctx.email) : new Set<string>();
    const favoriteAuthors = fav ? Array.from(await getFavoriteEmails(ctx.email)) : undefined;
    const bookmarkedIds = bm ? await getBookmarkedPostIds(ctx.email) : undefined;

    const posts = await listPosts({
      search: search ?? undefined,
      club: club ?? undefined,
      excludeClubs: Array.from(hiddenSet),
      favoriteAuthors,
      bookmarkedIds,
      viewerEmail: ctx.email,
      before: (cursor ?? before) || undefined,
      limit,
      author: authorEmail || undefined,
    });

    const last = posts[posts.length - 1];
    const nextCursor =
      posts.length === limit && last ? (last.lastActivityAt ?? last.createdAt) : null;

    return {
      status: 200,
      body: {
        apiVersion: 1,
        posts: posts.map(agentPostDto),
        next_cursor: nextCursor,
      },
      headers: {} as Record<string, string>,
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
