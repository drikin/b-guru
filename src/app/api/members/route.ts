import { cleanDisplayName } from "@/lib/display-name";
import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { listMembers } from "@/lib/ghost";
import { gravatarUrl } from "@/lib/posts";
import { ensureUserId } from "@/lib/user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// In-process cache with 60s TTL to avoid hammering Ghost API on every keystroke
let cache: {
  data: { userId: string; email: string; name: string; avatar: string | null }[];
  ts: number;
} | null = null;
const CACHE_TTL = 60_000;

/** Ghost returns `avatar_image` as a full https://www.gravatar.com/avatar/<md5>
 * URL. Passing that through to the client made the member list render 30+
 * cross-origin avatar requests (measured 900-2,500ms each, and it leaks every
 * member's email hash to Automattic). Rewrite it to our same-origin proxy.
 * Anything that is not a gravatar URL (a custom upload, or null) is left as-is. */
function toProxiedAvatar(avatar: string | null | undefined, email: string): string | null {
  if (!avatar) return null;
  const m = avatar.match(/gravatar\.com\/avatar\/([a-f0-9]{32})/i);
  if (m) return `/api/avatar/${m[1].toLowerCase()}`;
  return avatar;
}

// GET /api/members — list paid members for @mention suggestions
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  if (cache && Date.now() - cache.ts < CACHE_TTL) {
    return NextResponse.json({ members: cache.data });
  }

  try {
    const members = await listMembers();
    // ビーグル（システムアカウント）を先頭に追加 → @ビーグル で明示的にメンション可能に
    const data = [
      {
        userId: await ensureUserId("system@backspace.fm"),
        email: "system@backspace.fm",
        name: "ビーグル",
        avatar: "/icon-192.png",
      },
      ...(await Promise.all(
        members
          .filter((m) => m.status === "paid" || m.status === "comped")
          .map(async (m) => ({
            userId: await ensureUserId(m.email),
            // `email` is deliberately kept: the club-leader picker PATCHes it
            // back (club_leaders is keyed by email) and the chat mention
            // highlighter compares it with the viewer's own address. `userId`
            // is the field clients should use for identity/links.
            email: m.email,
            name: cleanDisplayName(m.name) || m.email.split("@")[0],
            avatar: toProxiedAvatar(m.avatar_image, m.email) || gravatarUrl(m.email),
          }))
      )),
    ];
    cache = { data, ts: Date.now() };
    return NextResponse.json({ members: data });
  } catch (e: any) {
    console.error("members list error:", e.message);
    return NextResponse.json(
      { error: "メンバー情報の取得に失敗しました" },
      { status: 500 }
    );
  }
}
