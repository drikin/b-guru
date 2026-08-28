import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { CLUB_KEYS } from "@/lib/club-catalog";
import { getClubLeaders, setClubLeader } from "@/lib/club-leaders";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活「部長」の一覧（右SBの部長カード表示用）。要ログイン。
 *  応答: { leaders: { [club]: { club, email, name, avatar } } } */
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

/** 部長の設定/解除（admin のみ）。body: { club, email | null }
 *  - club が不正 → 400 / 未認証 → 401 / 非 admin → 403。
 *  - 部長に指定できるのは有効なメール形式の値に限る（任意入力は許可しない）。 */
export async function PATCH(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }

  let body: { club?: unknown; email?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400, headers: NO_CACHE });
  }
  const club = typeof body.club === "string" ? body.club : "";
  if (!CLUB_KEYS.has(club)) {
    return NextResponse.json({ error: "不正な部活です" }, { status: 400, headers: NO_CACHE });
  }
  // email: null = 部長を外す。非 null は有効なメール形式のみ許可。
  let leaderEmail: string | null = null;
  if (body.email !== null && body.email !== undefined) {
    if (typeof body.email !== "string") {
      return NextResponse.json({ error: "email が不正です" }, { status: 400, headers: NO_CACHE });
    }
    const e = body.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      return NextResponse.json({ error: "email の形式が不正です" }, { status: 400, headers: NO_CACHE });
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
