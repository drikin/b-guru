import { NextRequest, NextResponse } from "next/server";
import { setClubAction } from "@/lib/post-actions";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// PATCH /api/posts/[id]/club — 投稿の部活動ラベルを手動で付け替え（投稿者 or admin のみ）。
// body: { "club": "car" | null }  （null = ラベル外し）
export async function PATCH(
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400 });
  }
  const r = await setClubAction(email, postId, (body as { club?: unknown })?.club ?? null);
  return NextResponse.json(r.body, { status: r.status });
}
