/* Paid-member list for @mention suggestions — shared by the web
 * (GET /api/members) and the native apps (GET /api/agent/members).
 * Opaque user ids only: this list goes to every signed-in member, so it must
 * never carry email addresses. Cached in-process for 60 s (Ghost API). */
import { cleanDisplayName } from "./display-name";
import { listMembers } from "./ghost";
import { gravatarUrl } from "./posts";
import { ensureUserId } from "./user";

export interface MentionMember {
  userId: string;
  name: string;
  avatar: string | null;
}

let cache: { data: MentionMember[]; ts: number } | null = null;
const CACHE_TTL = 60_000;

/** Ghost returns `avatar_image` as a full https://www.gravatar.com/avatar/<md5>
 * URL. Passing that through to the client made the member list render 30+
 * cross-origin avatar requests (measured 900-2,500ms each, and it leaks every
 * member's email hash to Automattic). Rewrite it to our same-origin proxy.
 * Anything that is not a gravatar URL (a custom upload, or null) is left as-is. */
export function toProxiedAvatar(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  const m = avatar.match(/gravatar\.com\/avatar\/([a-f0-9]{32})/i);
  if (m) return `/api/avatar/${m[1].toLowerCase()}`;
  return avatar;
}

export async function mentionMembers(): Promise<MentionMember[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;
  const members = await listMembers();
  const data: MentionMember[] = [
    // ビーグル（システムアカウント）を先頭に → @ビーグル で明示的にメンション可能に
    { userId: await ensureUserId("system@backspace.fm"), name: "ビーグル", avatar: "/icon-192.png" },
    ...(await Promise.all(
      members
        .filter((m) => m.status === "paid" || m.status === "comped")
        .map(async (m) => ({
          // The club-leader picker PATCHes the userId and the server resolves
          // it (club_leaders stays email-keyed internally); the mention
          // highlighter compares userId with the viewer's own.
          userId: await ensureUserId(m.email),
          name: cleanDisplayName(m.name) || m.email.split("@")[0],
          avatar: toProxiedAvatar(m.avatar_image) || gravatarUrl(m.email),
        }))
    )),
  ];
  cache = { data, ts: Date.now() };
  return data;
}
