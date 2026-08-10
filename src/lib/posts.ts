/* Feed posts library: DB CRUD + image + URL preview helpers */
import crypto from "crypto";
import { pool } from "./db";
import { fetchUrlPreview, UrlPreview } from "./urlpreview";

export interface FeedPost {
  id: number;
  authorEmail: string;
  authorName: string | null;
  authorAvatar?: string | null;
  parentId?: number | null;
  replyCount?: number;
  /** Direct replies to this post, chronological (newest-last). Used for inline
   *  "insert between cards" rendering in the grouped timeline. */
  replies?: FeedPost[];
  /** Latest activity time: the max of this post's created_at and its newest
   *  reply's created_at. Used to bump a group/post to the top of the timeline
   *  when a comment is inserted. */
  lastActivityAt?: string;
  /** If this post is currently pinned by its author (within the 24h window). */
  pinnedAt?: string | null;
  /** Hot-topic only: number of comments (incl. whispers) in the last 7 days. */
  recentComments?: number;
  text: string;
  images: string[]; // relative or absolute URLs
  urlPreview: UrlPreview | null;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
}

export interface NewPostInput {
  authorEmail: string;
  authorName: string | null;
  text: string;
  images?: string[];
  parentId?: number | null;
  /** Whisper reply: appended to the group but does NOT bump last_activity,
   *  so the timeline position stays unchanged. */
  isWhisper?: boolean;
}

function firstUrl(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)"'<>]+/);
  return m ? m[0] : null;
}

/** Create a post + its images (transaction), fetching URL preview. */
export async function createPost(input: NewPostInput): Promise<FeedPost> {
  // Fetch preview (best effort, don't block failure)
  let urlPreview: UrlPreview | null = null;
  const rawUrl = firstUrl(input.text);
  if (rawUrl) {
    urlPreview = await fetchUrlPreview(rawUrl);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ins = await client.query(
      `INSERT INTO posts (author_email, author_name, text, url_preview, parent_id, is_whisper)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [input.authorEmail, input.authorName, input.text, JSON.stringify(urlPreview), input.parentId ?? null, !!input.isWhisper]
    );
    const postId = ins.rows[0].id;
    const createdAt = ins.rows[0].created_at;

    const images = input.images ?? [];
    for (let i = 0; i < images.length; i++) {
      await client.query(
        `INSERT INTO post_images (post_id, url, sort_order) VALUES ($1, $2, $3)`,
        [postId, images[i], i]
      );
    }
    await client.query("COMMIT");

    return {
      id: postId,
      authorEmail: input.authorEmail,
      authorName: input.authorName,
      text: input.text,
      images,
      urlPreview,
      likeCount: 0,
      likedByMe: false,
      createdAt: new Date(createdAt).toISOString(),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Shared SELECT fragment and row→FeedPost mapper used by listPosts / getPostThread. */
const POST_SELECT = `
  SELECT p.id, p.author_email, p.author_name, p.parent_id, p.text, p.url_preview, p.created_at,
    GREATEST(p.created_at,
      COALESCE((SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = p.id AND r.is_whisper IS NOT TRUE), p.created_at)
    ) AS last_activity,
    CASE WHEN p.pinned_at IS NOT NULL AND p.pinned_at > now() - interval '24 hours'
         THEN p.pinned_at ELSE NULL END AS pinned_at,
    COALESCE((
      SELECT array_agg(pi2.url ORDER BY pi2.sort_order)
      FROM post_images pi2 WHERE pi2.post_id = p.id
    ), '{}') AS images,
    COUNT(DISTINCT l.user_email) AS like_count,
    BOOL_OR(l.user_email = $1) AS liked_by_me,
    (SELECT COUNT(*) FROM posts c WHERE c.parent_id = p.id) AS reply_count
  FROM posts p
  LEFT JOIN post_likes l ON l.post_id = p.id
`;

function mapRow(r: any): FeedPost {
  return {
    id: r.id,
    authorEmail: r.author_email,
    authorName: r.author_name,
    authorAvatar: gravatarUrl(r.author_email),
    parentId: r.parent_id,
    replyCount: Number(r.reply_count) || 0,
    text: r.text,
    images: r.images ?? [],
    urlPreview: r.url_preview,
    likeCount: Number(r.like_count) || 0,
    likedByMe: !!r.liked_by_me,
    createdAt: new Date(r.created_at).toISOString(),
    lastActivityAt: new Date(r.last_activity).toISOString(),
    pinnedAt: r.pinned_at ? new Date(r.pinned_at).toISOString() : null,
  };
}

/** Fetch root posts newest first (optionally filtered), each with its direct
 *  replies embedded (chronological) so the timeline can render them inline
 *  "inserted between the author's cards". */
export async function listPosts(options?: {
  filter?: "images" | "links" | "episodes";
  /** pinnedOnly: return ONLY currently active pins (within 24h), FIFO order
   *  (oldest-pinned first). Used by the right-sidebar pin summary panel. */
  pinnedOnly?: boolean;
  limit?: number;
  viewerEmail?: string;
  /** Cursor: return only posts whose latest activity is OLDER than this ISO
   *  timestamp (for infinite-scroll pagination back in time). */
  before?: string;
}): Promise<FeedPost[]> {
  const limit = options?.limit ?? 100;
  const viewerEmail = options?.viewerEmail ?? "";
  const before = options?.before;

  let where = "p.parent_id IS NULL";
  if (options?.pinnedOnly) {
    // Active pins only (FIFO). No filter/date overrides apply.
    where += ` AND p.pinned_at IS NOT NULL AND p.pinned_at > now() - interval '24 hours'`;
  } else if (options?.filter === "images") {
    where += " AND EXISTS (SELECT 1 FROM post_images pi WHERE pi.post_id = p.id)";
  } else if (options?.filter === "links") {
    // "ニュース" = user/shared posts containing a URL, EXCLUDING auto-posted episodes
    where += ` AND p.text ~* 'https?://[^\\s]+' AND p.source_ghost_id IS NULL AND p.drinews_article_id IS NULL`;
  } else if (options?.filter === "episodes") {
    where += " AND p.source_ghost_id IS NOT NULL";
  }

  // last_activity = max(post.created_at, newest reply.created_at). Repeated from
  // POST_SELECT so we can filter (cursor) and sort by it.
  const lastActExpr = `GREATEST(p.created_at, COALESCE((SELECT MAX(r.created_at) FROM posts r WHERE r.parent_id = p.id AND r.is_whisper IS NOT TRUE), p.created_at))`;

  const params: unknown[] = [viewerEmail, limit];
  let cursorSql = "";
  if (before && before.length > 0 && !options?.pinnedOnly) {
    params.push(before);
    cursorSql = ` AND ${lastActExpr} < $${params.length}`;
  }

  // Timeline (non-pinnedOnly): pure latest-activity order — NO pin special-casing
  // (pins moved to the right sidebar). pinnedOnly: FIFO (oldest pin first).
  const orderBy = options?.pinnedOnly
    ? "p.pinned_at ASC NULLS LAST"
    : "last_activity DESC";

  const res = await pool.query(
    `${POST_SELECT}
     WHERE ${where}${cursorSql}
     GROUP BY p.id
     ORDER BY ${orderBy}
     LIMIT $2`,
    params
  );

  const posts = res.rows.map(mapRow);
  if (posts.length === 0) return posts;

  // Embed direct replies per root post (chronological). Batch-fetch replies for
  // all visible root post ids in one query, then attach keyed by parent_id.
  const ids = posts.map((p) => p.id);
  const replyRes = await pool.query(
    `${POST_SELECT}
     WHERE p.parent_id = ANY($2::int[])
     GROUP BY p.id
     ORDER BY p.created_at ASC`,
    [viewerEmail, ids]
  );
  const repliesByParent = new Map<number, FeedPost[]>();
  for (const r of replyRes.rows) {
    const reply = mapRow(r);
    const parentId = r.parent_id as number;
    const arr = repliesByParent.get(parentId) ?? [];
    arr.push(reply);
    repliesByParent.set(parentId, arr);
  }
  for (const p of posts) {
    const rs = repliesByParent.get(p.id);
    if (rs?.length) p.replies = rs;
  }

  return posts;
}

/**
 * Fetch a post and its replies (chronological), for the individual thread view.
 * Calls data-format helpers shared with listPosts.
 */
export async function getPostThread(
  id: number,
  viewerEmail: string
): Promise<{ post: FeedPost | null; replies: FeedPost[] }> {
  const [postRes, replyRes] = await Promise.all([
    pool.query(`${POST_SELECT} WHERE p.id = $2 GROUP BY p.id LIMIT 1`, [viewerEmail, id]),
    pool.query(
      `${POST_SELECT} WHERE p.parent_id = $2 GROUP BY p.id ORDER BY p.created_at ASC`,
      [viewerEmail, id]
    ),
  ]);

  return {
    post: postRes.rows.length ? mapRow(postRes.rows[0]) : null,
    replies: replyRes.rows.map(mapRow),
  };
}

/** ホットトピック: 直近7日間で最もコメント（ささやき含む）が付いたルート投稿の上位 limit 件。
 *  盛り上がり度 = 7日間のコメント数（いいねは集計対象外 — 無効のため）。スコア降順 → 最終アクティビティ順。 */
export async function listHotTopics(
  viewerEmail: string,
  limit = 5
): Promise<FeedPost[]> {
  const res = await pool.query(
    `${POST_SELECT}
     WHERE p.parent_id IS NULL
       AND EXISTS (
         SELECT 1 FROM posts r
         WHERE r.parent_id = p.id AND r.created_at > now() - interval '7 days'
       )
     GROUP BY p.id
     ORDER BY
       (SELECT COUNT(*) FROM posts r
        WHERE r.parent_id = p.id AND r.created_at > now() - interval '7 days') DESC,
       last_activity DESC
     LIMIT $2`,
    [viewerEmail, limit]
  );
  const posts = res.rows.map(mapRow);
  if (posts.length === 0) return posts;

  // Attach the 7-day comment count (incl. whispers) for each hot topic.
  const ids = posts.map((p) => p.id);
  const cntRes = await pool.query(
    `SELECT r.parent_id AS pid, COUNT(*)::int AS n
     FROM posts r
     WHERE r.parent_id = ANY($1::int[]) AND r.created_at > now() - interval '7 days'
     GROUP BY r.parent_id`,
    [ids]
  );
  const cnt = new Map<number, number>(cntRes.rows.map((r) => [r.pid, r.n]));
  for (const p of posts) p.recentComments = cnt.get(p.id) ?? 0;

  return posts;
}

/** System-poster email for auto-posted episodes (BSM podcast). */
export const SYSTEM_EMAIL = "system@backspace.fm";

/** Resolve a Gravatar URL from an email (matches Ghost's avatar_image).
 * d=404 → returns HTTP 404 if the user has no Gravatar, so the UI can
 * fall back to its initial-letter avatar instead of a blank image.
 * System posts (auto-posted episodes) use the B-guru icon instead. */
export function gravatarUrl(email: string): string {
  if ((email || "").trim().toLowerCase() === SYSTEM_EMAIL) {
    return "/icon-192.png";
  }
  const md5 = crypto
    .createHash("md5")
    .update((email || "").trim().toLowerCase())
    .digest("hex");
  return `https://www.gravatar.com/avatar/${md5}?s=250&r=g&d=404`;
}

/** Toggle a like for a post. Returns the new like state. */
export async function toggleLike(postId: number, userEmail: string): Promise<{
  liked: boolean;
  likeCount: number;
}> {
  // Check the post exists
  const exists = await pool.query(`SELECT 1 FROM posts WHERE id = $1`, [postId]);
  if (exists.rows.length === 0) {
    throw new Error("not_found");
  }

  const already = await pool.query(
    `SELECT 1 FROM post_likes WHERE post_id = $1 AND user_email = $2`,
    [postId, userEmail]
  );

  if (already.rows.length > 0) {
    await pool.query(
      `DELETE FROM post_likes WHERE post_id = $1 AND user_email = $2`,
      [postId, userEmail]
    );
  } else {
    await pool.query(
      `INSERT INTO post_likes (post_id, user_email) VALUES ($1, $2)`,
      [postId, userEmail]
    );
  }

  const cnt = await pool.query(
    `SELECT COUNT(*) AS c FROM post_likes WHERE post_id = $1`,
    [postId]
  );

  return {
    liked: already.rows.length === 0,
    likeCount: Number(cnt.rows[0].c),
  };
}

/** Get a single post's author email. Returns null if not found. */
async function getPostAuthor(postId: number): Promise<string | null> {
  const res = await pool.query(`SELECT author_email FROM posts WHERE id = $1`, [postId]);
  return res.rows.length ? res.rows[0].author_email : null;
}

/**
 * Toggle pin for a user's OWN post. Only the author can pin. Rules:
 *  - Pin sets pinned_at = now() (active for 24h; expired pins are ignored in the list).
 *  - "Last one wins": pinning a post clears any other pinned post by the SAME author
 *    (so each member holds at most one active pin).
 * Returns the new pinned state (true if now pinned, false if unpinned).
 */
export async function togglePin(
  postId: number,
  userEmail: string
): Promise<{ ok: boolean; pinned: boolean; error?: string }> {
  const authorEmail = await getPostAuthor(postId);
  if (authorEmail === null) return { ok: false, pinned: false, error: "not_found" };
  if (authorEmail !== userEmail) {
    return { ok: false, pinned: false, error: "自分の投稿だけピンできます" };
  }

  const isEp = await pool.query(
    `SELECT 1 FROM posts WHERE id = $1 AND source_ghost_id IS NOT NULL`,
    [postId]
  );
  if (isEp.rows.length > 0) {
    return { ok: false, pinned: false, error: "エピソード投稿はピンできません" };
  }

  const cur = await pool.query(
    `SELECT pinned_at FROM posts WHERE id = $1 AND pinned_at IS NOT NULL AND pinned_at > now() - interval '24 hours'`,
    [postId]
  );
  const alreadyPinned = cur.rows.length > 0;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (alreadyPinned) {
      // Unpin this post.
      await client.query(`UPDATE posts SET pinned_at = NULL WHERE id = $1`, [postId]);
    } else {
      // Last-one-wins: clear any other active pin by this author, then pin this.
      await client.query(
        `UPDATE posts SET pinned_at = NULL WHERE author_email = $1 AND id <> $2`,
        [userEmail, postId]
      );
      await client.query(`UPDATE posts SET pinned_at = now() WHERE id = $1`, [postId]);
    }
    await client.query("COMMIT");
    return { ok: true, pinned: alreadyPinned ? false : true };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Update the text (and optionally images) of a user's own post.
 * Episode auto-posts (source_ghost_id) are not editable by anyone.
 */
export async function updatePost(
  postId: number,
  userEmail: string,
  input: { text?: string; images?: string[] }
): Promise<{ ok: boolean; error?: string }> {
  const authorEmail = await getPostAuthor(postId);
  if (authorEmail === null) return { ok: false, error: "not_found" };

  const src = await pool.query(`SELECT source_ghost_id FROM posts WHERE id = $1`, [postId]);
  if (src.rows[0]?.source_ghost_id) {
    return { ok: false, error: "エピソード投稿は編集できません" };
  }
  if (authorEmail !== userEmail) {
    return { ok: false, error: "自分の投稿のみ編集できます" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE posts SET text = $1, url_preview = NULL WHERE id = $2`, [
      input.text ?? "",
      postId,
    ]);
    // Replace images if provided
    if (input.images) {
      await client.query(`DELETE FROM post_images WHERE post_id = $1`, [postId]);
      const q = `INSERT INTO post_images (post_id, url, sort_order) VALUES ($1, $2, $3)`;
      for (let i = 0; i < input.images.length; i++) {
        await client.query(q, [postId, input.images[i], i]);
      }
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (e: any) {
    await client.query("ROLLBACK");
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

/** Delete a user's own post. Episode auto-posts are not deletable by anyone. */
export async function deletePost(
  postId: number,
  userEmail: string
): Promise<{ ok: boolean; error?: string }> {
  const authorEmail = await getPostAuthor(postId);
  if (authorEmail === null) return { ok: false, error: "not_found" };

  const src = await pool.query(`SELECT source_ghost_id FROM posts WHERE id = $1`, [postId]);
  if (src.rows[0]?.source_ghost_id) {
    return { ok: false, error: "エピソード投稿は削除できません" };
  }
  if (authorEmail !== userEmail) {
    return { ok: false, error: "自分の投稿のみ削除できます" };
  }

  // post_images / post_likes are ON DELETE CASCADE
  await pool.query(`DELETE FROM posts WHERE id = $1`, [postId]);
  return { ok: true };
}
