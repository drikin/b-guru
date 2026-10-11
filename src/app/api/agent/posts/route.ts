/* GET /api/agent/posts — タイムライン（読み取り専用・スコープ read）。
 * cursor ページング（last_activity ベース・既存 before と同型）、limit 上限 100。
 * フィルタ: club / search / since_id / fav / bookmark。author_user_id は
 * 不透明 user_id で指定（内部で email に解決・レスポンスには email を含めない）。 */
import { NextRequest } from "next/server";
import { listPosts } from "@/lib/posts";
import { listPostsSince } from "@/lib/agent-posts-since";
import { pool } from "@/lib/db";
import { getHiddenClubs } from "@/lib/club-visibility";
import { getFavoriteEmails } from "@/lib/favorites";
import { getBookmarkedPostIds } from "@/lib/bookmarks";
import { userIdToEmail } from "@/lib/user";
import { withAgent, sanitizeLikePattern } from "@/lib/agent-auth";
import { agentCreatePost, asAgentPostDto } from "@/lib/agent-write";
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
    const search = sanitizeLikePattern(sp.get("search") ?? undefined);
    const sinceIdRaw = Number(sp.get("since_id") ?? "");
    const fav = sp.get("fav") === "1";
    const bm = sp.get("bm") === "1";
    const authorUserId = sp.get("author_user_id") ?? undefined;

    // since_id: cursor が優先。「その投稿より新しい投稿を新しい順」で返す
    //   （共通 helper・MCP get_posts と単一正本）。
    if (!cursor && Number.isInteger(sinceIdRaw) && sinceIdRaw > 0) {
      const hiddenArr = Array.from(await getHiddenClubs(ctx.email));
      const posts = await listPostsSince(ctx, sinceIdRaw, limit, hiddenArr);
      return {
        status: 200,
        body: {
          apiVersion: 1,
          posts: posts.map(agentPostDto),
          next_cursor: null,
          has_more: posts.length === limit,
        },
        headers: NO_CACHE,
      };
    }

    const authorEmail = authorUserId ? await userIdToEmail(authorUserId) : undefined;
    if (authorUserId && !authorEmail) {
      return { status: 404, body: { error: "ユーザーが見つかりません", code: "not_found" } };
    }

    // hidden club は club フィルタ有無に関係なく常に適用
    //   （UI で非表示にした部活を agent が読めるのは意図しない挙動）。
    const hiddenSet = await getHiddenClubs(ctx.email);
    const favoriteAuthors = fav ? Array.from(await getFavoriteEmails(ctx.email)) : undefined;
    const bookmarkedIds = bm ? await getBookmarkedPostIds(ctx.email) : undefined;

    const posts = await listPosts({
      search: search ?? undefined,
      club: club ?? undefined,
      excludeClubs: Array.from(hiddenSet),
      favoriteAuthors,
      bookmarkedIds,
      viewerEmail: ctx.email,
      before: cursor || undefined,
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

/* POST /api/agent/posts — 新規投稿・返信（スコープ write）。自分名義のみ・
 * via: "agent" を自動付与。ロジックは src/lib/agent-write.ts が正本で、
 * MCP ツールと同一の薄い HTTP ビュー。 */
export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/posts", "write", async (ctx) => {
    let body: { text?: unknown; parent_id?: unknown; club?: unknown };
    try {
      body = await req.json();
    } catch {
      return {
        status: 400,
        body: { error: "JSON ボディが必要です", code: "invalid_request" },
        headers: {} as Record<string, string>,
      };
    }
    try {
      const post = await agentCreatePost(ctx, {
        text: typeof body.text === "string" ? body.text : "",
        parent_id: typeof body.parent_id === "number" ? body.parent_id : null,
        club: typeof body.club === "string" ? body.club : null,
      });
      return { status: 201, body: { apiVersion: 1, post: asAgentPostDto(post) }, headers: {} };
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string };
      const status = Number(err?.status) > 0 ? Number(err.status) : 400;
      return {
        status,
        body: {
          error: String(err?.message ?? "投稿に失敗しました"),
          code: err?.code ?? "invalid_request",
        },
        headers: {},
      };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
