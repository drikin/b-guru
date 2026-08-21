import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import { getPostPoll, gravatarUrl } from "@/lib/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" };

// GET /api/poll/feed — 右サイドバー「投票」ウィジェット用。
// 投票終了(ends_at)から +1日 までの投票を、リアルタイム統計つきで返す（上限5件）。
export async function GET(_req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_STORE });
  }

  // 表示条件: now() <= ends_at + 1 day  ⇔  ends_at > now() - interval '1 day'
  const res = await pool.query(
    `SELECT pp.post_id AS post_id, p.author_email AS author_email,
       COALESCE((SELECT up.display_name FROM user_profiles up WHERE up.email = p.author_email), p.author_name) AS author_name
     FROM post_polls pp
     JOIN posts p ON p.id = pp.post_id
     WHERE pp.ends_at > now() - interval '1 day'
     ORDER BY pp.ends_at ASC
     LIMIT 5`
  );

  const items: { postId: number; authorName: string | null; authorAvatar: string | null; poll: any }[] = [];
  for (const row of res.rows) {
    const poll = await getPostPoll(Number(row.post_id), email);
    if (!poll) continue;
    items.push({
      postId: Number(row.post_id),
      authorName: row.author_name ?? null,
      authorAvatar: gravatarUrl(row.author_email),
      poll,
    });
  }

  return NextResponse.json({ items }, { status: 200, headers: NO_STORE });
}
