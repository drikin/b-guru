import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getPinnedClubs, setClubPinned } from "@/lib/club-pins";
import { allClubs } from "@/lib/club-catalog";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// 「未設定」は常に最下段の固定枠なのでピン対象外。カタログにある部活だけ。
const isValidClubKey = (key: string) => allClubs().some((c) => c.key === key);

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
  if (!club || !isValidClubKey(club)) {
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
