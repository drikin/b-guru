import { NextRequest, NextResponse } from "next/server";
import { getPostThread } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";
import { getMutedWords } from "@/lib/muted-words";
import { deleteOwnPost, editOwnPost } from "@/lib/post-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** No-store headers — prevents the browser from caching this API's responses,
 *  so an edited/deleted post reflects immediately (and on a re-opened thread)
 *  instead of only after a hard reload. */
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

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
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400, headers: NO_CACHE });

  const { post, replies } = await getPostThread(postId, email, await getMutedWords(email));
  if (!post) return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404, headers: NO_CACHE });
  return NextResponse.json({ post, replies }, { headers: NO_CACHE });
}

// DELETE /api/posts/[id] — delete own post（lib/post-actions.ts。アプリ用 API と同じ正本）
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400, headers: NO_CACHE });

  const r = await deleteOwnPost(email, postId);
  return NextResponse.json(r.body, { status: r.status, headers: NO_CACHE });
}

// PATCH /api/posts/[id] — edit own post (text + images + audio)。検査は lib/post-actions.ts（アプリ用 API と同じ）。
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400, headers: NO_CACHE });

  let body: { text?: unknown; images?: unknown; audioUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400, headers: NO_CACHE });
  }

  const r = await editOwnPost(email, postId, body);
  return NextResponse.json(r.body, { status: r.status, headers: NO_CACHE });
}
