import { NextRequest, NextResponse } from "next/server";
import { deletePost, getPostThread, updatePost } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function getPostId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const postId = Number(id);
  return Number.isInteger(postId) && postId > 0 ? postId : null;
}

// GET /api/posts/[id] — post detail + its replies (thread view)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400 });

  const { post, replies } = await getPostThread(postId, email);
  if (!post) return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404 });
  return NextResponse.json({ post, replies });
}

// DELETE /api/posts/[id] — delete own post
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400 });

  const result = await deletePost(postId, email);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}

// PATCH /api/posts/[id] — edit own post (text + images)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400 });

  let body: { text?: string; images?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const images = Array.isArray(body.images) ? body.images.slice(0, 5) : undefined;

  if (!text && (!images || images.length === 0)) {
    return NextResponse.json({ error: "テキストまたは画像が必要です" }, { status: 400 });
  }

  const result = await updatePost(postId, email, { text, images });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status });
  }
  return NextResponse.json({ ok: true });
}
