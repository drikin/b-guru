import { NextRequest, NextResponse } from "next/server";
import { deletePost, getPostThread, updatePost } from "@/lib/posts";
import { getSessionEmail } from "@/lib/session";
import { emitLive } from "@/lib/live";
import { pool } from "@/lib/db";

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

  const { post, replies } = await getPostThread(postId, email);
  if (!post) return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404, headers: NO_CACHE });
  return NextResponse.json({ post, replies }, { headers: NO_CACHE });
}

// DELETE /api/posts/[id] — delete own post
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400, headers: NO_CACHE });

  const result = await deletePost(postId, email);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status, headers: NO_CACHE });
  }
  emitLive({ type: "post", postId, action: "delete", authorEmail: email });
  return NextResponse.json({ ok: true }, { headers: NO_CACHE });
}

// PATCH /api/posts/[id] — edit own post (text + images + audio)
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const postId = await getPostId(params);
  if (postId === null) return NextResponse.json({ error: "不正な投稿ID" }, { status: 400, headers: NO_CACHE });

  let body: { text?: string; images?: string[]; audioUrl?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400, headers: NO_CACHE });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const images = Array.isArray(body.images) ? body.images.slice(0, 5) : undefined;
  // Audio: undefined = leave as-is, null/"" = remove, string = set (server media path only).
  let audioUrl: string | null | undefined = undefined;
  if (body.audioUrl !== undefined) {
    if (body.audioUrl === null || body.audioUrl === "") {
      audioUrl = null;
    } else if (
      typeof body.audioUrl === "string" &&
      /^\/api\/media\/[^/]+$/.test(body.audioUrl)
    ) {
      audioUrl = body.audioUrl;
    } else {
      return NextResponse.json({ error: "不正な音声URLです" }, { status: 400, headers: NO_CACHE });
    }
  }

  if (!text && (!images || images.length === 0) && !audioUrl) {
    return NextResponse.json({ error: "テキスト・画像・音声のいずれかが必要です" }, { status: 400, headers: NO_CACHE });
  }

  // At most ONE attachment kind per post (mirrors the publish route). Only
  // reject when this request explicitly sets an audio URL on a post that
  // already carries a video (audioUrl === undefined means "leave as-is").
  if (audioUrl) {
    const cur = await pool.query(`SELECT video_url FROM posts WHERE id = $1`, [postId]);
    if (cur.rows[0]?.video_url) {
      return NextResponse.json(
        { error: "動画と音声は同時に添付できません" },
        { status: 400, headers: NO_CACHE }
      );
    }
  }

  const result = await updatePost(postId, email, { text, images, audioUrl });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : 403;
    return NextResponse.json({ error: result.error }, { status, headers: NO_CACHE });
  }
  emitLive({ type: "post", postId, action: "update", authorEmail: email });
  return NextResponse.json({ ok: true }, { headers: NO_CACHE });
}
