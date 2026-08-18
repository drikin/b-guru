import { NextRequest, NextResponse } from "next/server";
import { listPosts } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// GET /api/user/[email]/posts?before=&limit= — that user's root posts (cards),
// chronological cursor pagination, newest first. Reuses listPosts author filter.
export async function GET(req: NextRequest, { params }: { params: Promise<{ email: string }> }) {
  const me = await getSessionEmail();
  if (!me) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const { email } = await params;
  const dec = decodeURIComponent(email).toLowerCase();
  if (!dec || !dec.includes("@"))
    return NextResponse.json({ error: "不正なメールアドレス" }, { status: 400, headers: NO_CACHE });

  const u = new URL(req.url);
  const before = u.searchParams.get("before") || undefined;
  const rawLimit = Number(u.searchParams.get("limit") ?? "30");
  const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 30;

  try {
    const posts = await listPosts({ viewerEmail: me, author: dec, before, limit });
    return NextResponse.json(
      { posts, hasMore: posts.length === limit },
      { headers: NO_CACHE }
    );
  } catch {
    return NextResponse.json({ error: "投稿の取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
