import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  addFavorite,
  removeFavorite,
  listFavoriteIds,
  favoriteAuthorEmailFromUserId,
} from "@/lib/favorites";

export const dynamic = "force-dynamic";
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** GET /api/favorites — the viewer's favorited authors as opaque user_ids
 *  (emails NEVER leave the server). Newest first. */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const userIds = await listFavoriteIds(email);
    return NextResponse.json({ userIds }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("favorites GET error:", e.message);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** POST /api/favorites { userId } — add. DELETE { userId } — remove.
 *  Both idempotent, always return the final state. viewer==author is rejected. */
async function toggle(req: NextRequest, mode: "add" | "remove") {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    /* empty body → falls through to the 400 below */
  }
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!userId) {
    return NextResponse.json({ error: "userId が必要です" }, { status: 400, headers: NO_CACHE });
  }
  try {
    const authorEmail = await favoriteAuthorEmailFromUserId(userId);
    if (!authorEmail) {
      return NextResponse.json({ error: "ユーザーが見つかりません" }, { status: 404, headers: NO_CACHE });
    }
    if (authorEmail.trim().toLowerCase() === email.trim().toLowerCase()) {
      return NextResponse.json({ error: "自分自身はお気に入りにできません" }, { status: 400, headers: NO_CACHE });
    }
    const favorited =
      mode === "add" ? await addFavorite(email, authorEmail) : await removeFavorite(email, authorEmail);
    // お気に入り追加の通知は廃止（どりきん 2026-10-11「お気に入りの追加を通知に
    //   するのはやめましょう」）。通知 UI 側の type='favorite' 分岐は既存データ
    //   表示用に残す（削除しない — 過去に作られた通知が壊れないように）。
    return NextResponse.json({ favorited }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("favorites toggle error:", e.message);
    return NextResponse.json({ error: "処理に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

export async function POST(req: NextRequest) {
  return toggle(req, "add");
}

export async function DELETE(req: NextRequest) {
  return toggle(req, "remove");
}
