import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getHiddenClubs, setClubHidden } from "@/lib/club-visibility";
import { CLUB_UNSET } from "@/lib/club-catalog";
import { isActiveClubKey } from "@/lib/club-store";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// DB の active な部活（admin が後から追加した部活も含む）か「未設定」。静的 seed の
// allClubs() はサーバーでは追加分を知らないので使わない。表示に戻す側は、削除済み
// 部活の行も消せるよう検証しない。
const isValidClubKey = async (key: string, hidden: boolean) =>
  key === CLUB_UNSET ||
  (/^[a-z0-9_-]{1,40}$/.test(key) && (!hidden || (await isActiveClubKey(key))));

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
