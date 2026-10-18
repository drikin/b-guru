/* Timeline extras for the native apps (GET /api/agent/posts?include=…).
 *   include=reactions → each post carries `reactions` (same shape as chat)
 *   include=read      → each post carries `unread` (not read by the viewer, not own) and,
 *                       on root posts, `unread_replies` (replies by others not yet read)
 * Both are opt-in so existing MCP / agent clients get the same payload as before.
 * One query each for the whole page (and its replies) — no per-post round trips. */
import type { FeedPost } from "./posts";
import { getReactions } from "./reactions";
import { getReadIdsForPosts, getUnreadReplyCounts } from "./read-state-server";

export type TimelineInclude = { reactions: boolean; read: boolean };

export function parseInclude(raw: string | null): TimelineInclude {
  const parts = new Set((raw ?? "").split(",").map((s) => s.trim()));
  return { reactions: parts.has("reactions"), read: parts.has("read") };
}

type Extra = { reactions?: unknown[]; unread?: boolean; unread_replies?: number };

export async function timelineExtras(
  posts: FeedPost[],
  email: string,
  include: TimelineInclude
): Promise<Map<number, Extra>> {
  const out = new Map<number, Extra>();
  if (!include.reactions && !include.read) return out;
  const ids = posts.map((p) => p.id).filter((id) => id > 0);
  const roots = posts.filter((p) => !p.parentId && p.id > 0).map((p) => p.id);
  const [reactions, readIds, replyCounts] = await Promise.all([
    include.reactions ? getReactions("post", ids, email) : Promise.resolve(null),
    include.read ? getReadIdsForPosts(email, ids) : Promise.resolve(null),
    include.read ? getUnreadReplyCounts(email, roots) : Promise.resolve(null),
  ]);
  const read = new Set(readIds ?? []);
  for (const p of posts) {
    const e: Extra = {};
    if (reactions) e.reactions = reactions.get(p.id) ?? [];
    if (readIds) e.unread = !p.isAuthor && !read.has(p.id);
    if (replyCounts && !p.parentId) e.unread_replies = replyCounts.get(p.id) ?? 0;
    out.set(p.id, e);
  }
  return out;
}
