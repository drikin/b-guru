import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getProfile } from "@/lib/profile";
import { findMemberByEmail } from "@/lib/ghost";
import { gravatarUrl } from "@/lib/posts";

export const dynamic = "force-dynamic";

/** Ghost returns `avatar_image` as a full https://www.gravatar.com/avatar/<md5>
 * URL. Passing that through made the client fetch it cross-origin (measured
 * 900-2,500ms, and it leaks the member's email hash to Automattic). Rewrite it
 * to our same-origin proxy. Non-gravatar values (custom uploads) pass through. */
function toProxiedAvatar(avatar: string | null | undefined): string | null {
  if (!avatar) return null;
  const m = avatar.match(/gravatar\.com\/avatar\/([a-f0-9]{32})/i);
  if (m) return `/api/avatar/${m[1].toLowerCase()}`;
  return avatar;
}

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  // Resolve the display name from B-guru's own profile (user_profiles), so the
  // bottom-left corner / composer match the timeline. Falls back to the Ghost
  // member name when the user has no B-guru profile, and to email local-part.
  let name: string | null = null;
  try {
    const profile = await getProfile(email);
    if (profile) name = profile.name;
  } catch {}

  // Avatar comes from the Ghost member profile (same as before).
  let avatar: string | null = null;
  try {
    const member = await findMemberByEmail(email);
    if (member) {
      if (!name) name = member.name || null;
      avatar = toProxiedAvatar(member.avatar_image) || gravatarUrl(email);
    }
  } catch {}

  return NextResponse.json({
    authenticated: true,
    email,
    name,
    avatar,
  });
}
