import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { deleteComment } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DELETE /api/drinews/comments/[id] — delete a comment (author or drikin)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const { id } = await params;
  const commentId = Number(id);
  if (!Number.isInteger(commentId) || commentId <= 0) {
    return NextResponse.json({ error: "不正なID" }, { status: 400 });
  }

  const result = await deleteComment(commentId, email);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
