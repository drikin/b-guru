import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { listFavoriteIds } from "@/lib/favorites";
import { setFavorite } from "@/lib/post-actions";

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
  // お気に入り追加の通知は廃止（どりきん 2026-10-11）。検査は lib/post-actions.ts（アプリ用 API と同じ）。
  const r = await setFavorite(email, body?.userId, mode);
  return NextResponse.json(r.body, { status: r.status, headers: NO_CACHE });
}

export async function POST(req: NextRequest) {
  return toggle(req, "add");
}

export async function DELETE(req: NextRequest) {
  return toggle(req, "remove");
}
