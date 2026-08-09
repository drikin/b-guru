import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { addComment } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/[id]/comments — add a comment (any member)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const { id } = await params;
  const articleId = Number(id);
  if (!Number.isInteger(articleId) || articleId <= 0) {
    return NextResponse.json({ error: "不正なID" }, { status: 400 });
  }

  let body: { comment?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const comment = (body.comment ?? "").trim().slice(0, 2000);
  if (!comment) return NextResponse.json({ error: "コメントを入力してください" }, { status: 400 });

  try {
    const c = await addComment(articleId, {
      authorEmail: email,
      authorName: body.name || null,
      comment,
    });
    return NextResponse.json({ comment: c }, { status: 201 });
  } catch (e: any) {
    const status = e.message === "not_found" ? 404 : e.message === "not_published" ? 403 : 500;
    const msg =
      e.message === "not_found"
        ? "記事が見つかりません"
        : e.message === "not_published"
        ? "公開前の記事にはコメントできません"
        : "コメントの投稿に失敗しました";
    return NextResponse.json({ error: msg }, { status });
  }
}
