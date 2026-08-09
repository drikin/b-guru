import { NextRequest, NextResponse } from "next/server";
import { createPost } from "@/lib/posts";
import { createNotification } from "@/lib/notifications";
import { findMemberByEmail } from "@/lib/ghost";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import { emitLive } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/publish  — body: { text: string, images?: string[] }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: { text?: string; images?: unknown; parentId?: unknown; whisper?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const text = (body.text ?? "").toString().trim();
  const rawImages = Array.isArray(body.images) ? body.images : [];
  const parentId =
    typeof body.parentId === "number" && body.parentId > 0 ? body.parentId : null;
  const isWhisper = body.whisper === true;

  if (!text && rawImages.length === 0) {
    return NextResponse.json({ error: "テキストまたは画像が必要です" }, { status: 400 });
  }
  if (rawImages.length > 5) {
    return NextResponse.json({ error: "画像は最大5枚までです" }, { status: 400 });
  }
  // Validate image URLs
  const images = rawImages
    .filter((u) => typeof u === "string")
    .map((u) => u as string)
    .slice(0, 5);

  // Resolve member name
  let authorName: string | null = null;
  try {
    const member = await findMemberByEmail(email);
    authorName = member?.name || null;
  } catch {}

  try {
    const post = await createPost({
      authorEmail: email,
      authorName,
      text,
      images,
      parentId,
      isWhisper,
    });

    // If this is a reply, notify the parent post's author
    if (parentId) {
      try {
        const parent = await pool.query(
          `SELECT author_email, author_name FROM posts WHERE id = $1`,
          [parentId]
        );
        if (parent.rows.length > 0) {
          const parentAuthor = parent.rows[0].author_email;
          const parentName = parent.rows[0].author_name;
          // Don't notify if replying to your own post
          if (parentAuthor !== email) {
            await createNotification({
              userEmail: parentAuthor,
              type: "reply",
              actorEmail: email,
              actorName: authorName,
              postId: parentId,
              replyId: post.id,
              text: text.length > 60 ? text.slice(0, 57) + "…" : text,
            });
          }
        }
      } catch (ne) {
        console.error("notify reply error:", (ne as any).message);
      }
    }

    // Push a live "timeline changed" signal to connected clients.
    emitLive({ type: "post", postId: post.id, action: "create" });

    return NextResponse.json({ post }, { status: 201 });
  } catch (e: any) {
    console.error("publish error:", e.message);
    return NextResponse.json({ error: "投稿に失敗しました" }, { status: 500 });
  }
}
