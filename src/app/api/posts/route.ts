import { NextRequest, NextResponse } from "next/server";
import { listPosts, listHotTopics } from "@/lib/posts";
import { getReadIdsForPosts } from "@/lib/read-state-server";
import { findMemberByEmail } from "@/lib/ghost";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

/** No-store headers to prevent the browser from caching API responses.
 *  Without this, `fetch("/api/posts")` returns a stale cached response
 *  after posting/editing/deleting, so the timeline doesn't update until
 *  a full page reload bypasses the cache. */
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// GET /api/posts?filter=images|links  /  GET /api/posts?pinned=1
export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  const pinned = req.nextUrl.searchParams.get("pinned") === "1";
  const hot = req.nextUrl.searchParams.get("hot") === "1";
  const search = req.nextUrl.searchParams.get("search") ?? undefined;
  const filter = req.nextUrl.searchParams.get("filter") as
    | "images"
    | "links"
    | "episodes"
    | null;
  const before = req.nextUrl.searchParams.get("before") ?? undefined;
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 100;
  const club = req.nextUrl.searchParams.get("club") ?? undefined;

  try {
    if (hot) {
      // Hot topics: top N most-commented root posts in the last 7 days.
      const posts = await listHotTopics(email, Math.min(limit, 5));
      return NextResponse.json({ posts }, { headers: NO_CACHE });
    }
    const posts = await listPosts({
      pinnedOnly: pinned || undefined,
      filter: filter ?? undefined,
      search: search ?? undefined,
      club: club ?? undefined,
      viewerEmail: email,
      before,
      limit,
    });
    // ★ 既読 ID を同じ応答に同梱する（tochi 2026-09-27 の未読共通化）。
    //   新規 GET エンドポイントを作ると初回ペイントに 1 往復増え、
    //   オーナー制約「パフォーマンスは低下させない」に反する。
    //   フィードは既に毎回この API を叩いているので、同梱なら往復ゼロ増。
    //   返すのは**この応答に含まれる投稿の既読だけ**（全件返すと無駄が大きい）。
    const visibleIds: number[] = [];
    for (const p of posts) {
      visibleIds.push(p.id);
      for (const r of p.replies ?? []) visibleIds.push(r.id);
    }
    const readIds = await getReadIdsForPosts(email, visibleIds);
    return NextResponse.json({ posts, readIds }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("posts GET error:", e.message);
    return NextResponse.json(
      { error: "投稿の取得に失敗しました" },
      { status: 500, headers: NO_CACHE }
    );
  }
}

// (POST is delegated to the client via the publish endpoint; kept for completeness)
export async function POST(req: NextRequest) {
  return NextResponse.json(
    { error: "POST は非対応です" },
    { status: 405 }
  );
}
