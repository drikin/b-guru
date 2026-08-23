import { cleanDisplayName } from "@/lib/display-name";
import { NextRequest, NextResponse } from "next/server";
import { createPost } from "@/lib/posts";
import { createNotification } from "@/lib/notifications";
import { findMemberByEmail, listMembers } from "@/lib/ghost";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import { emitLive } from "@/lib/live";
import { sendWebPush } from "@/lib/push";
import { validatePollInput } from "@/lib/poll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---- Server-side duplicate prevention (30s window) ----
// If the same author posts the exact same text + parentId within 30 seconds,
// return the previously created post instead of creating a duplicate.
const DEDUP_WINDOW = 30_000;
const recentPosts = new Map<string, { at: number; post: any }>();

// POST /api/publish  — body: { text: string, images?: string[] }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: { text?: string; images?: unknown; parentId?: unknown; whisper?: unknown; videoUrl?: unknown; poll?: unknown };
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
  // At most one video: only accept a non-empty string; anything else → null.
  const videoUrl =
    typeof body.videoUrl === "string" && body.videoUrl.trim().length > 0
      ? body.videoUrl.trim()
      : null;

  // アンケート（投票）: 任意。ルート投稿のみ（返信では無視され、ここで弾かない）。
  const pollRaw = body.poll as
    | { question?: unknown; options?: unknown; durationHours?: unknown }
    | null
    | undefined;
  let poll: { question: string; options: string[]; durationHours: number } | null = null;
  if (pollRaw != null) {
    const q = pollRaw.question ?? "";
    const opts = Array.isArray(pollRaw.options) ? pollRaw.options : [];
    const dur = typeof pollRaw.durationHours === "number" ? pollRaw.durationHours : 24;
    const err = validatePollInput(q, opts, dur);
    if (err) {
      return NextResponse.json({ error: err }, { status: 400 });
    }
    poll = {
      question: String(q).trim(),
      options: opts.map((o: unknown) => String(o).trim()).filter(Boolean),
      durationHours: dur,
    };
  }

  if (!text && rawImages.length === 0 && !videoUrl && !poll) {
    return NextResponse.json({ error: "テキスト・画像・動画・投票のいずれかが必要です" }, { status: 400 });
  }
  if (rawImages.length > 5) {
    return NextResponse.json({ error: "画像は最大5枚までです" }, { status: 400 });
  }
  // Validate image URLs
  const images = rawImages
    .filter((u) => typeof u === "string")
    .map((u) => u as string)
    .slice(0, 5);
  // Validate video URL shape (must be a server media path)
  if (videoUrl && !/^\/api\/media\/[^/]+$/.test(videoUrl)) {
    return NextResponse.json({ error: "不正な動画URLです" }, { status: 400 });
  }

  // Resolve member name
  let authorName: string | null = null;
  try {
    const member = await findMemberByEmail(email);
    authorName = member?.name || null;
  } catch {}

  // ---- Duplicate prevention: same author + text + parentId within 30s ----
  const dedupKey = `${email}:${parentId ?? "root"}:${text}`;
  const prev = recentPosts.get(dedupKey);
  if (prev && Date.now() - prev.at < DEDUP_WINDOW) {
    // Return the existing post — don't create a duplicate.
    return NextResponse.json({ post: prev.post }, { status: 201 });
  }

  try {
    const post = await createPost({
      authorEmail: email,
      authorName,
      text,
      images,
      videoUrl,
      parentId,
      isWhisper,
      poll,
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

    // ---- @mention notifications ----
    // Parse @name tokens from text, match against paid members, notify each.
    try {
      const members = await listMembers();
      // Build a lookup: name (lowercase) → email
      const nameMap = new Map<string, string>();
      for (const m of members) {
        const name = (cleanDisplayName(m.name) || m.email.split("@")[0] || "").trim();
        if (name) nameMap.set(name.toLowerCase(), m.email);
      }
      // Extract @mentions: @[Full Name] (bracket syntax for spaces) or @name
      const bracketMentions = text.match(/@\[([^\]]+)\]/g) || [];
      const plainMentions = text.match(/@([^\s@\[]+)/g) || [];
      const notifiedEmails = new Set<string>();
      const tryNotify = async (name: string) => {
        const targetEmail = nameMap.get(name.toLowerCase());
        if (targetEmail && targetEmail !== email && !notifiedEmails.has(targetEmail)) {
          notifiedEmails.add(targetEmail);
          await createNotification({
            userEmail: targetEmail,
            type: "mention",
            actorEmail: email,
            actorName: authorName,
            postId: post.id,
            replyId: null,
            text: text.length > 60 ? text.slice(0, 57) + "…" : text,
          });
        }
      };
      for (const token of bracketMentions) {
        await tryNotify(token.slice(2, -1)); // remove @[ and ]
      }
      for (const token of plainMentions) {
        await tryNotify(token.slice(1)); // remove @
      }
    } catch (me) {
      console.error("mention notify error:", (me as any).message);
    }

    // Push a live "timeline changed" signal to connected clients.
    // Include the author's email so the author's own client can skip
    // a redundant silentRefreshFeed (it already did an optimistic update).
    emitLive({ type: "post", postId: post.id, action: "create", authorEmail: email });

    // Web Push notification — sent for EVERY new post AND every new comment, but
    // NEVER for whispers (ささやき = quiet by design). Every push-enabled member
    // except the actor gets an OS/browser notification. Fire-and-forget (not
    // awaited) so the publish response stays fast; sendWebPush never throws.
    // Comments are only ever attached to a root post, so parentId (when present)
    // IS the root post id — clicking a comment push opens that thread.
    if (!isWhisper) {
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 60);
      const isRoot = !parentId;
      const who = authorName || email.split("@")[0];
      const action = isRoot ? "が吠えた" : "がコメント";
      sendWebPush({
        title: isRoot ? "B-guru 新着投稿" : "B-guru 新着コメント",
        body: preview ? `🐾 ${who}${action}: ${preview}` : `🐾 ${who}${action}`,
        // Absolute URL — a relative "#/post/<id>" would resolve against the SW
        // path (/sw.js) in a cached service worker and open the SW source.
        url: `${(process.env.APP_URL || "").replace(/\/+$/, "")}#/post/${parentId ?? post.id}`,
        excludeEmail: email,
      }).catch(() => {});
    }

    // Record in dedup map so a double-submit within 30s returns this post.
    recentPosts.set(dedupKey, { at: Date.now(), post });
    // Clean old entries periodically.
    if (recentPosts.size > 200) {
      const now = Date.now();
      for (const [k, v] of recentPosts) {
        if (now - v.at > DEDUP_WINDOW) recentPosts.delete(k);
      }
    }

    return NextResponse.json({ post }, { status: 201 });
  } catch (e: any) {
    console.error("publish error:", e.message);
    return NextResponse.json({ error: "投稿に失敗しました" }, { status: 500 });
  }
}
