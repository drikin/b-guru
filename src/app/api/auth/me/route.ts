import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { findMemberByEmail } from "@/lib/ghost";

export const dynamic = "force-dynamic";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ authenticated: false }, { status: 200 });
  }

  // Resolve member profile (name / avatar) from Ghost.
  let profile: { name?: string; avatar_image?: string } = {};
  try {
    const member = await findMemberByEmail(email);
    if (member) {
      profile = {
        name: member.name || undefined,
        avatar_image: member.avatar_image || undefined,
      };
    }
  } catch {}

  return NextResponse.json({
    authenticated: true,
    email,
    name: profile.name || null,
    avatar: profile.avatar_image || null,
  });
}
