import { NextRequest, NextResponse } from "next/server";
import { listPosts } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";
import { userIdToEmail } from "@/lib/user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** Resolve an opaque user_id OR legacy email segment to an email (or null). */
async function resolveEmail(segment: string): Promise<string | null> {
  const dec = decodeURIComponent(segment).trim();
  if (!dec) return null;
  if (dec.includes("@")) return dec.toLowerCase(); // legacy email URL
  return userIdToEmail(dec); // opaque public user_id
}

// GET /api/user/[id]/posts?before=&limit= — that user's root posts (cards),
// chronological cursor pagination, newest first. Reuses listPosts author filter.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const me = await getSessionEmail();
  if (!me) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const email = await resolveEmail((await params).id);
  if (!email)
    return NextResponse.json({ error: "ユーザーが見つかりません" }, { status: 404, headers: NO_CACHE });

  const u = new URL(req.url);
  const before = u.searchParams.get("before") || undefined;
  const rawLimit = Number(u.searchParams.get("limit") ?? "30");
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 30;

  try {
    const posts = await listPosts({ viewerEmail: me, author: email, before, limit });
    return NextResponse.json(
      { posts, hasMore: posts.length === limit },
      { headers: NO_CACHE }
    );
  } catch {
    return NextResponse.json({ error: "投稿の取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
