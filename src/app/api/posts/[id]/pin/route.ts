import { NextRequest, NextResponse } from "next/server";
import { togglePin } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";
import { emitLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/posts/[id]/pin — toggle pin (own post only, 24h)
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
    const result = await togglePin(postId, email);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : 403;
      return NextResponse.json({ error: result.error }, { status });
    }
    emitLive({ type: "pin", postId, action: "toggle" });
    return NextResponse.json({ ok: true, pinned: result.pinned });
  } catch (e: any) {
    console.error("pin error:", e.message);
    return NextResponse.json({ error: "ピンの更新に失敗しました" }, { status: 500 });
  }
}