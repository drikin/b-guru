import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getProfile } from "@/lib/profile";
import { findMemberByEmail } from "@/lib/ghost";

export const dynamic = "force-dynamic";

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
      avatar = member.avatar_image || null;
    }
  } catch {}

  return NextResponse.json({
    authenticated: true,
    email,
    name,
    avatar,
  });
}
