/* Timeline extras for the native apps (GET /api/agent/posts?include=…).
 *   include=reactions → each post carries `reactions` (same shape as chat; sorted by
 *                       count desc, then emoji — lib/timeline-display.ts. `count` is the
 *                       total, `reactors` holds at most 12 names → "他 count-12 人")
 *   include=display   → each post carries `display`: the display decisions the web makes
 *                       (fold at 500, reaction order, link card, mentions, …) computed by the
 *                       same functions the web uses (lib/timeline-display.ts, docs/timeline-spec.md)
 *   include=read      → each post carries `unread` (not read by the viewer, not own) and,
 *                       on root posts, `unread_replies` (replies by others not yet read)
 * Both are opt-in so existing MCP / agent clients get the same payload as before.
 * One query each for the whole page (and its replies) — no per-post round trips. */
import type { FeedPost } from "./posts";
import { getReactions } from "./reactions";
import { getReadIdsForPosts, getUnreadReplyCounts } from "./read-state-server";
import { mentionMembers } from "./members";
import { listClubs } from "./club-store";
import { clubLabel } from "./club-catalog";
import { computePostDisplay, type PostDisplay } from "./timeline-display";

export type TimelineInclude = { reactions: boolean; read: boolean; display: boolean };

export function parseInclude(raw: string | null): TimelineInclude {
  const parts = new Set((raw ?? "").split(",").map((s) => s.trim()));
  return { reactions: parts.has("reactions"), read: parts.has("read"), display: parts.has("display") };
}

type Extra = { reactions?: unknown[]; unread?: boolean; unread_replies?: number; display?: PostDisplay };

/** Member names for mention matching (the same list the web's /api/members serves). A
 *  failure (Ghost down) yields no mentions rather than failing the timeline. */
async function memberNames(): Promise<string[]> {
  try {
    // Ghost を待たない: 一覧がまだ無ければメンション無しで返し、取り直しは裏で（QA 2026-10-22）。
    return (await mentionMembers({ wait: false })).map((m) => m.name);
  } catch {
    return [];
  }
}

/** key → 表示名 from the clubs table (deleted clubs too, like the web's clubLabel). Falls
 *  back to the built-in catalog when the table cannot be read. */
async function clubNamer(): Promise<(key: string) => string | null> {
  try {
    const rows = await listClubs({ activeOnly: false });
    const map = new Map(rows.map((r) => [r.key, r.name]));
    return (key) => map.get(key) ?? clubLabel(key);
  } catch {
    return (key) => clubLabel(key);
  }
}

export async function timelineExtras(
  posts: FeedPost[],
  email: string,
  include: TimelineInclude
): Promise<Map<number, Extra>> {
  const out = new Map<number, Extra>();
  if (!include.reactions && !include.read && !include.display) return out;
  const ids = posts.map((p) => p.id).filter((id) => id > 0);
  const roots = posts.filter((p) => !p.parentId && p.id > 0).map((p) => p.id);
  const wantReactions = include.reactions || include.display; // display needs them for the order
  const [reactions, readIds, replyCounts, names, clubName] = await Promise.all([
    wantReactions ? getReactions("post", ids, email) : Promise.resolve(null),
    include.read ? getReadIdsForPosts(email, ids) : Promise.resolve(null),
    include.read ? getUnreadReplyCounts(email, roots) : Promise.resolve(null),
    include.display ? memberNames() : Promise.resolve([] as string[]),
    include.display ? clubNamer() : Promise.resolve(null),
  ]);
  const read = new Set(readIds ?? []);
  for (const p of posts) {
    const e: Extra = {};
    if (reactions && include.reactions) e.reactions = reactions.get(p.id) ?? [];
    if (readIds) e.unread = !p.isAuthor && !read.has(p.id);
    if (replyCounts && !p.parentId) e.unread_replies = replyCounts.get(p.id) ?? 0;
    if (include.display) {
      e.display = computePostDisplay(
        { text: p.text, images: p.images, url_preview: p.urlPreview, club: p.club, reactions: reactions?.get(p.id) ?? [] },
        { memberNames: names, clubName: clubName ?? clubLabel }
      );
    }
    out.set(p.id, e);
  }
  return out;
}
