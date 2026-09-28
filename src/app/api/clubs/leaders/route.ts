import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { CLUB_KEYS } from "@/lib/club-catalog";
import { getClubLeaders, setClubLeader } from "@/lib/club-leaders";
import { userIdToEmail } from "@/lib/user";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活「部長」の一覧（右SBの部長カード表示用）。要ログイン。
 *  応答: { leaders: { [club]: { club, userId, name, avatar, headerImage, bio } } }
 *  userId は不透明な公開ID。email はサーバー内部にのみ残す（漏洩防止）。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const leaders = await getClubLeaders();
    return NextResponse.json({ leaders }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/leaders GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}

/** 部長の設定/解除（admin のみ）。body: { club, userId | null }
 *  - club が不正 → 400 / 未認証 → 401 / 非 admin → 403。
 *  - userId は /api/members が返す不透明ID。サーバーが users から email を引く
 *    （club_leaders は内部的に email キーのまま。email は API 境界を越えない）。
 *  - 未知の userId → 400（任意の email を部長にすることはできない）。 */
export async function PATCH(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }

  let body: { club?: unknown; userId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400, headers: NO_CACHE });
  }
  const club = typeof body.club === "string" ? body.club : "";
  if (!CLUB_KEYS.has(club)) {
    return NextResponse.json({ error: "不正な部活です" }, { status: 400, headers: NO_CACHE });
  }
  // 旧契約 { club, email } は受け付けない。userId が無い body を「解除」と解釈すると、
  // 古い JS のままの admin タブで部長を選んだ瞬間に、既存の部長が 200 のまま消える。
  // 解除は明示の { userId: null } のみ。
  if (!("userId" in body)) {
    return NextResponse.json(
      { error: "画面が古いバージョンです。再読み込みしてください" },
      { status: 400, headers: NO_CACHE }
    );
  }
  // userId: null = 部長を外す。非 null は users に存在する userId のみ許可。
  let leaderEmail: string | null = null;
  if (body.userId !== null && body.userId !== undefined) {
    if (typeof body.userId !== "string" || !body.userId.trim()) {
      return NextResponse.json({ error: "userId が不正です" }, { status: 400, headers: NO_CACHE });
    }
    const e = await userIdToEmail(body.userId.trim());
    if (!e) {
      return NextResponse.json({ error: "該当するメンバーがいません" }, { status: 400, headers: NO_CACHE });
    }
    leaderEmail = e;
  }

  try {
    const leader = await setClubLeader(club, leaderEmail);
    return NextResponse.json({ club, leader }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/leaders PATCH error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
