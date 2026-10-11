import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { addBookmark, removeBookmark, getBookmarkedPostIds } from "@/lib/bookmarks";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** GET /api/bookmarks — the viewer's bookmarked post ids, newest first. */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const postIds = await getBookmarkedPostIds(email);
    return NextResponse.json({ postIds }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("bookmarks GET error:", e.message);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** POST /api/bookmarks { postId } — add. DELETE { postId } — remove.
 *  Both idempotent, always return the final state. No notifications —
 *  bookmarking is the viewer's own act and affects nobody else. */
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
  const postId = Number(body?.postId);
  if (!Number.isInteger(postId) || postId <= 0 || postId > 2147483647) {
    return NextResponse.json({ error: "postId が必要です" }, { status: 400, headers: NO_CACHE });
  }
  try {
    // 存在確認: 削除済み/存在しない投稿へのブックマークは 404。
    //   CASCADE が行を消してくれるが、追加時の 404 はここで明示する。
    if (mode === "add") {
      const exists = await pool.query(`SELECT 1 FROM posts WHERE id = $1 LIMIT 1`, [postId]);
      if (exists.rows.length === 0) {
        return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404, headers: NO_CACHE });
      }
    }
    const bookmarked =
      mode === "add" ? await addBookmark(email, postId) : await removeBookmark(email, postId);
    return NextResponse.json({ bookmarked }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("bookmarks toggle error:", e.message);
    return NextResponse.json({ error: "処理に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

export async function POST(req: NextRequest) {
  return toggle(req, "add");
}

export async function DELETE(req: NextRequest) {
  return toggle(req, "remove");
}
