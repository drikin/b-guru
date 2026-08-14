/**
 * Pure, side-effect-free feed helpers shared by the timeline page and covered by
 * unit tests (`src/lib/__tests__/feed.test.ts`).
 *
 * These are the TIMING-SENSITIVE pieces of the posting flow — optimistic reply
 * insertion, whisper position semantics, and client-side group sort — where a
 * regression is easy to introduce and hard to notice by eye. Keeping them here
 * (no React, no browser, no DB, no network) lets the test suite verify them in
 * isolation before any deploy.
 */

export interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  videoId?: string;
}

export interface FeedPost {
  id: number;
  authorEmail: string;
  authorName: string | null;
  authorAvatar?: string | null;
  parentId?: number | null;
  replyCount?: number;
  replies?: FeedPost[];
  lastActivityAt?: string;
  pinnedAt?: string | null;
  recentComments?: number;
  text: string;
  images: string[];
  /** At most one video attachment (nullable URL), rendered as a <video> player. */
  videoUrl?: string | null;
  urlPreview: UrlPreview | null;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
}

export interface FeedGroup {
  dateKey: string;
  authorEmail: string;
  authorName: string;
  authorAvatar?: string | null;
  lastActivity: string;
  posts: FeedPost[]; // exactly ONE root post per group (its replies live in posts[0].replies)
}

/** JST date string "YYYY-MM-DD" for grouping (empty when the timestamp is bad). */
export function jstDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD
}

/** Each ROOT post is its own group (main card + its replying comments). Date key
 *  comes from the post's LATEST activity (own or newest reply), so inserting a
 *  comment keeps it on the right day and bumps it to the top of the timeline. */
export function groupFeed(posts: FeedPost[]): FeedGroup[] {
  return posts
    .map((p): FeedGroup | null => {
      const act = p.lastActivityAt || p.createdAt;
      const dateKey = jstDateKey(act);
      if (!dateKey) return null;
      return {
        dateKey,
        authorEmail: p.authorEmail,
        authorName: p.authorName || p.authorEmail.split("@")[0],
        authorAvatar: p.authorAvatar || null,
        lastActivity: act,
        posts: [p],
      };
    })
    .filter((g): g is FeedGroup => g !== null)
    .sort((a, b) => {
      // Pure latest-activity order. (Pins were moved to the right sidebar and
      // no longer affect timeline position.)
      return a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0;
    });
}

/**
 * Optimistically append a reply to its parent group in the local feed.
 *
 * - whisper: the group stays put (lastActivity UNCHANGED); only the new reply
 *   is appended inside it, and its reply count still increments.
 * - comment: the group's lastActivity follows the new reply and the group is
 *   bumped to the top of the timeline.
 *
 * If the parent group is not present in `feed` at all, returns the input
 * UNCHANGED (the caller must fall back to a server refresh rather than
 * silently dropping the comment).
 */
export function appendReplyLocal(
  feed: FeedPost[],
  parentId: number,
  created: FeedPost,
  whisper: boolean
): FeedPost[] {
  const now = created.createdAt || new Date().toISOString();
  const reply: FeedPost = {
    id: created.id,
    authorEmail: created.authorEmail,
    authorName: created.authorName ?? null,
    authorAvatar: created.authorAvatar ?? null,
    parentId,
    text: created.text ?? "",
    images: created.images ?? [],
    urlPreview: created.urlPreview ?? null,
    likeCount: created.likeCount ?? 0,
    likedByMe: created.likedByMe ?? false,
    createdAt: now,
    lastActivityAt: now,
    replies: [],
    replyCount: 0,
  };

  const appendTo = (root: FeedPost): FeedPost => {
    const list = [...(root.replies ?? [])];
    const exists = list.some((rp) => rp.id === reply.id);
    if (!exists) {
      list.push(reply);
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    const bumped = {
      ...root,
      replies: list,
      // Only increment the count when we actually inserted (idempotent for the
      // same reply id — otherwise an SSE race that re-runs the insert would
      // inflate replyCount without adding a reply).
      replyCount: (root.replyCount ?? 0) + (exists ? 0 : 1),
      // Normal comments move the group up (its lastActivity follows the new
      // reply); whispers deliberately leave lastActivity unchanged.
      lastActivityAt: whisper ? root.lastActivityAt : now,
    };
    return bumped;
  };

  let changed = false;
  const next = feed.map((root) => {
    if (root.id === parentId) {
      changed = true;
      return appendTo(root);
    }
    if ((root.replies ?? []).some((rp) => rp.id === parentId)) {
      changed = true;
      return appendTo(root);
    }
    return root;
  });

  if (!changed) return feed;

  if (whisper) return next;

  // For a normal comment, bring the bumped group to the top.
  const bumped = next.find(
    (r) => r.id === parentId || (r.replies ?? []).some((rp) => rp.id === parentId)
  );
  if (!bumped) return next;
  return [bumped, ...next.filter((r) => r !== bumped)];
}

/** True if `parentId` appears as a root post or as a reply nested in some root
 *  of the currently loaded feed. If false, appending a reply to the local feed
 *  would silently do nothing (the old "comment doesn't reflect" bug), so the
 *  caller falls back to a reliable server refresh instead. */
export function parentInFeed(feed: FeedPost[], parentId: number): boolean {
  return feed.some(
    (r) => r.id === parentId || (r.replies ?? []).some((rp) => rp.id === parentId)
  );
}

/** Replace an optimistic reply (tempId) with the authoritative server reply
 *  (`created`), also dropping any stale reply carrying the same REAL id that a
 *  silentRefreshFeed may have raced in during the in-flight request. Keeps the
 *  group's lastActivity semantics (whisper = unchanged). */
export function replaceReplyInFeed(
  feed: FeedPost[],
  parentId: number,
  tempId: number,
  created: FeedPost,
  whisper: boolean
): FeedPost[] {
  const freshReply: FeedPost = {
    ...created,
    id: created.id,
    parentId,
    replies: [],
    replyCount: 0,
  };
  return feed.map((root) => {
    if (
      root.id !== parentId &&
      !(root.replies ?? []).some((rp) => rp.id === parentId || rp.id === tempId)
    ) {
      return root;
    }
    const filtered = (root.replies ?? []).filter(
      (rp) => rp.id !== tempId && rp.id !== created.id
    );
    // Use the REAL reply's createdAt for sorting (the optimistic temp had a
    // client timestamp; the server one is final).
    const sorted = [...filtered, freshReply].sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0
    );
    return {
      ...root,
      replies: sorted,
      replyCount: sorted.length,
      lastActivityAt: whisper ? root.lastActivityAt : created.lastActivityAt || created.createdAt,
    };
  });
}

/** Remove an optimistic reply (rollback path on failure). */
export function removeReplyTemp(feed: FeedPost[], parentId: number, tempId: number): FeedPost[] {
  return feed.map((root) => {
    if (
      root.id !== parentId &&
      !(root.replies ?? []).some((rp) => rp.id === parentId || rp.id === tempId)
    ) {
      return root;
    }
    const replies = (root.replies ?? []).filter((rp) => rp.id !== tempId);
    return {
      ...root,
      replies,
      replyCount: Math.max(0, (root.replyCount ?? 0) - 1),
    };
  });
}


/**
 * Merge a freshly fetched page-1 list (`fresh`, authoritative server order)
 * into the current local feed (`prev`).
 *
 * - Posts present in BOTH: the server version wins (authoritative for sort
 *   order, reply count, likes, URL previews) but any optimistic reply the
 *   server hasn't seen yet (tempId or just-created real replies) is preserved.
 * - Posts NOT in `fresh` are kept as-is (older pages / optimistic temp roots).
 * - `lastActivityAt` keeps the NEWER of local/server. A comment optimistically
 *   bumps its group locally, and a silentRefresh that races ahead of that
 *   comment's server commit would otherwise clobber the bump with a stale
 *   value and sink the group back down (the "comment didn't float the group
 *   to the top" bug). max() is safe for whispers too — they never move it.
 */
export function mergeFreshFeed(prev: FeedPost[], fresh: FeedPost[]): FeedPost[] {
  if (fresh.length === 0 && prev.length === 0) return prev;
  const freshIds = new Set(fresh.map((p) => p.id));
  const prevMap = new Map(prev.map((p) => [p.id, p]));
  const merged = fresh.map((fp) => {
    const oldP = prevMap.get(fp.id);
    if (!oldP) return fp;
    const serverReplyIds = new Set((fp.replies ?? []).map((r) => r.id));
    const oldReplies = oldP.replies ?? [];
    const preservedReplies = oldReplies.filter(
      (rp) => !serverReplyIds.has(rp.id) && rp.id > 0
    );
    const mergedActivity =
      oldP.lastActivityAt && fp.lastActivityAt && oldP.lastActivityAt > fp.lastActivityAt
        ? oldP.lastActivityAt
        : fp.lastActivityAt;
    if (preservedReplies.length > 0) {
      return {
        ...fp,
        replies: [...(fp.replies ?? []), ...preservedReplies],
        ...(mergedActivity !== fp.lastActivityAt ? { lastActivityAt: mergedActivity } : {}),
      };
    }
    return mergedActivity !== fp.lastActivityAt ? { ...fp, lastActivityAt: mergedActivity } : fp;
  });
  const older = prev.filter((p) => !freshIds.has(p.id) && p.id > 0);
  return [...merged, ...older];
}
