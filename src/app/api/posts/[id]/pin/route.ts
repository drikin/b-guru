import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { togglePinAction } from "@/lib/post-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/posts/[id]/pin — toggle pin (own post only, 24h)。lib/post-actions.ts（アプリ用 API と同じ）
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

  const r = await togglePinAction(email, postId);
  return NextResponse.json(r.body, { status: r.status });
}
