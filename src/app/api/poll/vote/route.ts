import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import { getPostPoll } from "@/lib/posts";
import { emitLive } from "@/lib/live";

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
  if (postId <= 0 || optionId <= 0) {
    return NextResponse.json({ error: "不正な投票内容です" }, { status: 400, headers: NO_STORE });
  }

  // アンケートと締切・選択肢の検証
  const pollRow = await pool.query(
    `SELECT po.post_id, po.ends_at, po.post_id AS pid FROM post_polls po WHERE po.post_id = $1`,
    [postId]
  );
  if (pollRow.rows.length === 0) {
    return NextResponse.json({ error: "アンケートが見つかりません" }, { status: 404, headers: NO_STORE });
  }
  const endsAt = new Date(pollRow.rows[0].ends_at).getTime();
  if (Date.now() > endsAt) {
    return NextResponse.json({ error: "投票は終了しました" }, { status: 403, headers: NO_STORE });
  }
  const optRow = await pool.query(
    `SELECT id FROM post_poll_options WHERE post_id = $1 AND id = $2`,
    [postId, optionId]
  );
  if (optRow.rows.length === 0) {
    return NextResponse.json({ error: "選択肢が不正です" }, { status: 400, headers: NO_STORE });
  }

  // 投票（初回 INSERT / 変更は UPDATE）。締切前なら変更可能 = ON CONFLICT で UPDATE。
  await pool.query(
    `INSERT INTO post_poll_votes (post_id, option_id, email, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (post_id, email)
     DO UPDATE SET option_id = EXCLUDED.option_id, updated_at = now()`,
    [postId, optionId, email]
  );

  const poll = await getPostPoll(postId, email);
  if (!poll) {
    return NextResponse.json({ error: "アンケートが見つかりません" }, { status: 404, headers: NO_STORE });
  }

  try {
    emitLive({ type: "poll", action: "vote", postId, poll });
  } catch {
    /* ignore */
  }

  return NextResponse.json({ ok: true, poll }, { status: 200, headers: NO_STORE });
}
