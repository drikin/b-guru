import { NextRequest, NextResponse } from "next/server";
import { setPostClub } from "@/lib/posts";
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
  const clubValue: unknown = (body as { club?: unknown })?.club ?? null;
  if (clubValue !== null && typeof clubValue !== "string") {
    return NextResponse.json({ error: "club は文字列または null のみ" }, { status: 400 });
  }
  const club = clubValue as string | null;

  try {
    const result = await setPostClub(postId, email, club);
    if (!result.ok) {
      const status =
        result.error === "not_found" ? 404 : result.error === "不正な部活動です" ? 400 : 403;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ ok: true, club });
  } catch (e: any) {
    console.error("set club error:", e.message);
    return NextResponse.json({ error: "部活動ラベルの更新に失敗しました" }, { status: 500 });
  }
}
