import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { mentionMembers } from "@/lib/members";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/members — list paid members for @mention suggestions (lib/members.ts)
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  try {
    return NextResponse.json({ members: await mentionMembers() });
  } catch (e: any) {
    console.error("members list error:", e.message);
    return NextResponse.json(
      { error: "メンバー情報の取得に失敗しました" },
      { status: 500 }
    );
  }
}
