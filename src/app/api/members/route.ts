import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { mentionMembers } from "@/lib/members";
import { ensureUserId } from "@/lib/user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/members — list paid members for @mention suggestions (lib/members.ts)
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  try {
    // me: 自分の user_id（✉️ 新規 DM の候補から自分を外すため）。
    const [members, me] = await Promise.all([mentionMembers(), ensureUserId(email)]);
    return NextResponse.json({ members, me });
  } catch (e: any) {
    console.error("members list error:", e.message);
    return NextResponse.json(
      { error: "メンバー情報の取得に失敗しました" },
      { status: 500 }
    );
  }
}
