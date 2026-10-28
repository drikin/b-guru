import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getHiddenClubs, setClubHidden } from "@/lib/club-visibility";
import { isValidClubKey } from "@/lib/club-visibility-api";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export const dynamic = "force-dynamic";

/** GET /api/clubs/visibility — the set of club keys this user has hidden. */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const hidden = await getHiddenClubs(email);
    return NextResponse.json({ hidden: Array.from(hidden) }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/visibility GET error:", e.message);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** PUT /api/clubs/visibility — { club: "<key>", hidden: boolean }. */
export async function PUT(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  let body: { club?: unknown; hidden?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_CACHE });
  }
  const club = typeof body.club === "string" ? body.club.trim() : "";
  const hidden = body.hidden === true;
  if (!club || !(await isValidClubKey(club, hidden))) {
    return NextResponse.json({ error: "不正な部活キーです" }, { status: 400, headers: NO_CACHE });
  }
  try {
    await setClubHidden(email, club, hidden);
    return NextResponse.json({ club, hidden }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/visibility PUT error:", e.message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
