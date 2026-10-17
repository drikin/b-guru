import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getPinnedClubs, setClubPinned } from "@/lib/club-pins";
import { isActiveClubKey } from "@/lib/club-store";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// ピンできるのは DB の active な部活だけ（admin が後から追加した部活も含む。
// 静的 seed の allClubs() はサーバーでは追加分を知らない）。「未設定」は常に
// 最下段の固定枠なので対象外。外す側は、削除済み部活の行も消せるよう検証しない。
const isValidClubKey = async (key: string, pinned: boolean) =>
  /^[a-z0-9_-]{1,40}$/.test(key) && (!pinned || (await isActiveClubKey(key)));

export const dynamic = "force-dynamic";

/** GET /api/clubs/pins — this user's pinned club keys, in pin order. */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const pinned = await getPinnedClubs(email);
    return NextResponse.json({ pinned }, { headers: NO_CACHE });
  } catch (e) {
    console.error("clubs/pins GET error:", (e as Error).message);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** PUT /api/clubs/pins — { club: "<key>", pinned: boolean }. */
export async function PUT(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  let body: { club?: unknown; pinned?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_CACHE });
  }
  const club = typeof body.club === "string" ? body.club.trim() : "";
  const pinned = body.pinned === true;
  if (!club || !(await isValidClubKey(club, pinned))) {
    return NextResponse.json({ error: "不正な部活キーです" }, { status: 400, headers: NO_CACHE });
  }
  try {
    await setClubPinned(email, club, pinned);
    return NextResponse.json({ club, pinned }, { headers: NO_CACHE });
  } catch (e) {
    console.error("clubs/pins PUT error:", (e as Error).message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
