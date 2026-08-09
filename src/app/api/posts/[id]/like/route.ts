import { NextRequest, NextResponse } from "next/server";
import { toggleLike } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/posts/[id]/like — toggle a like
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { id } = await params;
  const postId = Number(id);
  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "不正な投稿ID" }, { status: 400 });
  }

  try {
    const result = await toggleLike(postId, email);
    return NextResponse.json(result);
  } catch (e: any) {
    if (e.message === "not_found") {
      return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404 });
    }
    console.error("like error:", e.message);
    return NextResponse.json({ error: "いいねの更新に失敗しました" }, { status: 500 });
  }
}
