/* 投稿の作成（Web の /api/publish とアプリの /api/agent/publish の共通の正本）。
 * 返信通知・@メンション通知・Live 配信・部活の自動分類・Web Push・30 秒の重複防止まで、
 * どちらから投稿しても同じ振る舞いになるようにここへ集めた（drikin 2026-10-16）。 */
import { cleanDisplayName, resolveDisplayNames } from "@/lib/display-name";
import { createPost } from "@/lib/posts";
import { createNotification } from "@/lib/notifications";
import { findMemberByEmail, listMembers } from "@/lib/ghost";
import { getProfile } from "@/lib/profile";
import { pool } from "@/lib/db";
import { emitLive } from "@/lib/live";
import { sendWebPush } from "@/lib/push";
import { pushNewPost } from "@/lib/push-notify";
import { validatePollInput } from "@/lib/poll";
import { classifyPost } from "@/lib/clubs";
import { ensureUserId } from "@/lib/user";
import { isActiveClubKey } from "@/lib/club-store";
import { setPostClub } from "@/lib/posts";

// ---- Server-side duplicate prevention (30s window) ----
// If the same author posts the exact same text + parentId within 30 seconds,
// return the previously created post instead of creating a duplicate.
const DEDUP_WINDOW = 30_000;
const recentPosts = new Map<string, { at: number; post: any }>();

export interface PublishBody {
  text?: string;
  images?: unknown;
  parentId?: unknown;
  whisper?: unknown;
  videoUrl?: unknown;
  audioUrl?: unknown;
  poll?: unknown;
  /** 部活を手動で選んで投稿する（ルート投稿だけ）。付けたら自動分類はしない（club_manual = TRUE）。 */
  club?: unknown;
}

/** Uploaded images are served from /api/media/<name> (see /api/upload). */
// Chat photos (chat-…) are deleted after 24 h, so a post may not borrow one.
export const LOCAL_IMAGE_RE = /^\/api\/media\/(?!chat-)[A-Za-z0-9._-]+$/;

export async function publishPost(
  email: string,
  body: PublishBody,
  opts: { localImagesOnly?: boolean } = {}
): Promise<{ status: number; body: any }> {
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
  // At most one audio: only accept a non-empty string; anything else → null.
  const audioUrl =
    typeof body.audioUrl === "string" && body.audioUrl.trim().length > 0
      ? body.audioUrl.trim()
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
    // 文字列でない回答（数・配列・オブジェクト）は弾く。以前は検査では空として数えず、保存では String() にしていたので、
    // 上限（数・文字数）をすり抜けて保存できた（セキュリティの指摘 2026-10-22）。検査と保存は同じ値を使う。
    if (opts.some((o: unknown) => typeof o !== "string")) {
      return { status: 400, body: { error: "回答は文字列で入力してください" } };
    }
    if (typeof q !== "string") {
      return { status: 400, body: { error: "アンケートの質問を入力してください" } };
    }
    const labels = (opts as string[]).map((o) => o.trim()).filter(Boolean);
    const err = validatePollInput(q, labels, dur);
    if (err) {
      return { status: 400, body: { error: err } };
    }
    poll = {
      question: q.trim(),
      options: labels,
      durationHours: dur,
    };
  }

  // 部活の手動選択（任意）。投稿を作る前に検査する（作ってから弾くと投稿だけ残る）。
  const club = typeof body.club === "string" && body.club.trim() ? body.club.trim() : null;
  if (body.club != null && typeof body.club !== "string") {
    return { status: 400, body: { error: "club は文字列のみ" } };
  }
  if (club && parentId) {
    return { status: 400, body: { error: "返信には部活を付けられません（スレッドの部活はルート投稿で変えます）" } };
  }
  if (club && !(await isActiveClubKey(club))) {
    return { status: 400, body: { error: "不正な部活動です" } };
  }

  if (!text && rawImages.length === 0 && !videoUrl && !audioUrl && !poll) {
    return { status: 400, body: { error: "テキスト・画像・動画・音声・投票のいずれかが必要です" } };
  }
  if (rawImages.length > 5) {
    return { status: 400, body: { error: "画像は最大5枚までです" } };
  }
  // Validate image URLs
  const images = rawImages
    .filter((u) => typeof u === "string")
    .map((u) => u as string)
    .slice(0, 5);
  // Native apps may only attach images they uploaded to this server.
  if (opts.localImagesOnly && images.some((u) => !LOCAL_IMAGE_RE.test(u))) {
    return { status: 400, body: { error: "不正な画像URLです" } };
  }
  // Validate video URL shape (must be a server media path)
  if (videoUrl && !/^\/api\/media\/[^/]+$/.test(videoUrl)) {
    return { status: 400, body: { error: "不正な動画URLです" } };
  }
  // Validate audio URL shape (must be a server media path)
  if (audioUrl && !/^\/api\/media\/[^/]+$/.test(audioUrl)) {
    return { status: 400, body: { error: "不正な音声URLです" } };
  }
  // At most ONE attachment kind per post (the composer enforces this in the UI;
  // enforce it here too so a direct API caller can't create a post that renders
  // both an <audio> and a <video> player).
  if (videoUrl && audioUrl) {
    return { status: 400, body: { error: "動画と音声は同時に添付できません" } };
  }

  // Resolve the author's display name from B-guru's own profile (user_profiles)
  // first, so a name change in the profile is reflected on the very next post
  // (and on the optimistic swap) instead of showing the stale Ghost name until
  // a reload. Falls back to the Ghost member name when there's no B-guru profile.
  // Mirrors /api/auth/me so the stored author_name matches the session name.
  let authorName: string | null = null;
  try {
    const profile = await getProfile(email);
    if (profile) authorName = profile.name;
  } catch {}
  try {
    if (!authorName) {
      const member = await findMemberByEmail(email);
      authorName = member?.name || null;
    }
  } catch {}

  // ---- Duplicate prevention: same author + text + parentId within 30s ----
  const dedupKey = `${email}:${parentId ?? "root"}:${text}`;
  const prev = recentPosts.get(dedupKey);
  if (prev && Date.now() - prev.at < DEDUP_WINDOW) {
    // Return the existing post — don't create a duplicate.
    return { status: 201, body: { post: prev.post } };
  }

  try {
    const post = await createPost({
      authorEmail: email,
      authorName,
      text,
      images,
      videoUrl,
      audioUrl,
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
    // After the response (fire-and-forget): matching needs the whole member list from
    // Ghost (910 members = 10 pages ≈ 1.5 s when its 60 s cache is cold), and it used
    // to hold every post that long. Posts without "@" skip it entirely.
    if (text.includes("@")) {
      void notifyMentions(text, email, authorName, post.id).catch((me) =>
        console.error("mention notify error:", (me as any)?.message)
      );
    }

    // Push a live "timeline changed" signal to connected clients.
    // Include the author's OPAQUE user id (never the email — this payload is
    // broadcast to every connected client) so the author's own client can skip
    // a redundant silentRefreshFeed (it already did an optimistic update).
    emitLive({ type: "post", postId: post.id, action: "create", authorId: await ensureUserId(email) });

    // 部活動ラベル自動付与（ルート投稿のみ・非同期）。投稿の即時反映をブロックしない
    // よう fire-and-forget で投げる。分類完了は SSE club イベントで各クライアントへ
    // 反映される（classifyPost は内部でエラーを握りつぶし null を返すので throw しない）。
    if (club) {
      // 手動で選んだ部活（Web の付け替えと同じ setPostClub: club_manual = TRUE・club イベント）。
      const set = await setPostClub(post.id, email, club);
      if (set.ok) {
        post.club = club;
        post.clubManual = true;
      }
    } else if (!parentId) {
      classifyPost(post.id).catch((e) =>
        console.error("classifyPost:", (e as any)?.message)
      );
    }

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
      // The apps: a new post (not a comment) to members who turned timeline notifications on.
      if (isRoot) void pushNewPost(post.id, email).catch((pe) => console.error("pushNewPost:", (pe as any)?.message));
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

    return { status: 201, body: { post } };
  } catch (e: any) {
    console.error("publish error:", e.message);
    return { status: 500, body: { error: "投稿に失敗しました" } };
  }
}

/** @name / @[Full Name] → notification for each paid member it names. Names are matched
 *  against both the B-guru display name (what the @ picker and the 返信 button insert)
 *  and the Ghost account name, case-insensitively. */
async function notifyMentions(text: string, email: string, authorName: string | null, postId: number): Promise<void> {
  const tokens = [
    ...(text.match(/@\[([^\]]+)\]/g) || []).map((t) => t.slice(2, -1)),
    ...(text.match(/@([^\s@\[]+)/g) || []).map((t) => t.slice(1)),
  ];
  if (tokens.length === 0) return;
  const members = (await listMembers()).filter((m) => m.status === "paid" || m.status === "comped");
  const shown = await resolveDisplayNames(members.map((m) => m.email));
  const nameMap = new Map<string, string>();
  for (const m of members) {
    for (const n of [shown.get(m.email), cleanDisplayName(m.name), m.email.split("@")[0]]) {
      const k = (n || "").trim().toLowerCase();
      if (k && !nameMap.has(k)) nameMap.set(k, m.email);
    }
  }
  const notified = new Set<string>();
  for (const name of tokens) {
    const target = nameMap.get(name.trim().toLowerCase());
    if (!target || target === email || notified.has(target)) continue;
    notified.add(target);
    await createNotification({
      userEmail: target,
      type: "mention",
      actorEmail: email,
      actorName: authorName,
      postId,
      replyId: null,
      text: text.length > 60 ? text.slice(0, 57) + "…" : text,
    });
  }
}
