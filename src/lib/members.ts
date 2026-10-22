/* Paid-member list for @mention suggestions — shared by the web
 * (GET /api/members) and the native apps (GET /api/agent/members).
 * Opaque user ids only: this list goes to every signed-in member, so it must
 * never carry email addresses. Cached in-process for 60 s (Ghost API). */
import { cleanDisplayName } from "./display-name";
import { listMembers } from "./ghost";
import { gravatarUrl } from "./posts";
import { resolveDisplayNames } from "./display-name";
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

/** 失敗したらこの間は Ghost に取りに行かない（応答しない Ghost を毎回待たない）。 */
export const MENTION_FAIL_BACKOFF_MS = 30_000;
let refreshing: Promise<void> | null = null;
let failedAt = 0;

/** 取り直しは同時に 1 本だけ。失敗は覚えて MENTION_FAIL_BACKOFF_MS の間は取り直さない。 */
function refreshMembers(): Promise<void> {
  if (refreshing) return refreshing;
  if (Date.now() - failedAt < MENTION_FAIL_BACKOFF_MS) return Promise.resolve();
  refreshing = loadMentionMembers()
    .then((data) => {
      cache = { data, ts: Date.now() };
      failedAt = 0;
    })
    .catch((e) => {
      // Ghost に届かない・応答しない（4 秒で打ち切り）・GHOST_ADMIN_API_KEY が無い。画面は止めない。
      failedAt = Date.now();
      console.error("mentionMembers:", (e as Error)?.message, cache ? "(古い一覧を使う)" : "(空の一覧を使う)");
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * @メンションの候補（会員の一覧）。
 *  - 新しい一覧（60 秒以内）があればそれ。
 *  - 古い一覧があれば**すぐ返し**、取り直しは裏で 1 本だけ。
 *  - 一覧がまだ無いとき: wait=true（既定・/api/members と /api/agent/members）は取り直しを待つ（Ghost の
 *    問い合わせは 4 秒で打ち切り）。wait=false（タイムラインの include=display）は待たずに空を返し、裏で取りに行く。
 *  - 失敗した直後（30 秒）は取りに行かず、古い一覧か空。
 */
export async function mentionMembers(opts: { wait?: boolean } = {}): Promise<MentionMember[]> {
  if (cache && Date.now() - cache.ts < CACHE_TTL) return cache.data;
  if (cache) {
    void refreshMembers();
    return cache.data;
  }
  if (opts.wait === false) {
    void refreshMembers();
    return [];
  }
  await refreshMembers();
  return currentCache()?.data ?? [];
}

// 関数越しに読む（await の後に cache が埋まるのを TypeScript の絞り込みが知らないため）。
function currentCache(): { data: MentionMember[]; ts: number } | null {
  return cache;
}

/** テスト用: 覚えている一覧と失敗の記録を消す。 */
export function _resetMentionMembersForTest(): void {
  cache = null;
  refreshing = null;
  failedAt = 0;
}

async function loadMentionMembers(): Promise<MentionMember[]> {
  // GHOST_ADMIN_API_KEY が無いときは listMembers（makeToken）が投げる → 上で空の一覧。
  const members = (await listMembers()).filter((m) => m.status === "paid" || m.status === "comped");
  // The name a member is shown (and matched for mentions) as on B-guru: the
  // profile display name first — the same name the chat's 返信 button inserts.
  // Ghost's account name only when there is no B-guru name yet (riyu 2026-10-17:
  // 「返信」と @ 補完で宛先の表示が違う).
  const shown = await resolveDisplayNames(members.map((m) => m.email));
  const data: MentionMember[] = [
    // ビーグル（システムアカウント）を先頭に → @ビーグル で明示的にメンション可能に
    { userId: await ensureUserId("system@backspace.fm"), name: "ビーグル", avatar: "/icon-192.png" },
    ...(await Promise.all(
      members
        .map(async (m) => ({
          // The club-leader picker PATCHes the userId and the server resolves
          // it (club_leaders stays email-keyed internally); the mention
          // highlighter compares userId with the viewer's own.
          userId: await ensureUserId(m.email),
          name: shown.get(m.email) || cleanDisplayName(m.name) || m.email.split("@")[0],
          avatar: toProxiedAvatar(m.avatar_image) || gravatarUrl(m.email),
        }))
    )),
  ];
  cache = { data, ts: Date.now() };
  return data;
}
