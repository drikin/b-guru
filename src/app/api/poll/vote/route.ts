import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { votePoll } from "@/lib/post-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" };

// POST /api/poll/vote  — body { postId, optionId }
// 投票は無料。1票 / 1投稿 / 1ユーザー（UNIQUE(post_id,email) でDB強制）。
// 投票後、締切前なら何度でも投票変更可（同じ行を UPDATE）。締切後は 403。
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_STORE });
  }

  let body: { postId?: unknown; optionId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }
  const postId = typeof body.postId === "number" ? body.postId : 0;
  const optionId = typeof body.optionId === "number" ? body.optionId : 0;
  // 検査と書き込みは lib/post-actions.ts（アプリ用 API と同じ）。
  const r = await votePoll(email, postId, optionId);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
