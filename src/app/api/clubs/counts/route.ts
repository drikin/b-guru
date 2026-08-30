import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活ごとの直近7日アクティビティ数（左サイドバー「部活」バッジ・並び順用）。
 *
 * 未読数（削除済み）に代わる「活動の活性度」指標:
 *  - ルート投稿（親投稿）だけでなく、そのスレッドのコメントも含めてカウントする。
 *  - コメント自体には club が付いていない（AI分類はルートのみ）ため、
 *    コメントは「そのスレッドのルート投稿の club」に紐付けて集計する（自己JOIN）。
 *  - 対象は直近7日（ローリング）。ルートの club が NULL / __unset__ のものは
 *    「未設定」(activityUnset) 枠にまとめる（実部活と相補的になるよう）。
 *
 * 応答: { activity, activityTotal, activityUnset, updatedAt }
 *  - activity       : 部活キー → 直近7日メッセージ数（実部活のみ・__unset__ を除く）
 *  - activityTotal  : このビーグル全体の直近7日メッセージ総数（コメント含む・「すべて」用）
 *  - activityUnset  : 部活未設定（NULL / __unset__）の直近7日メッセージ数（「未設定」用）
 *  ユーザー入力なし・全クエリ静的（パラメタライズ不要）→ SQLインジェクションなし。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const res = await pool.query(
      `SELECT COALESCE(NULLIF(r.club, '__unset__'), '__unset__') AS club, count(*)::int AS n
         FROM posts p
         LEFT JOIN posts r ON r.id = COALESCE(p.parent_id, p.id)
        WHERE p.created_at > now() - interval '7 days'
        GROUP BY 1`
    );

    const activity: Record<string, number> = {};
    for (const row of res.rows as { club: string; n: number }[]) {
      activity[row.club] = row.n;
    }
    const activityUnset = activity["__unset__"] ?? 0;
    delete activity["__unset__"]; // 未設定は activityUnset として別返却
    const activityTotal =
      (Object.values(activity) as number[]).reduce((s, n) => s + n, 0) + activityUnset;

    return NextResponse.json(
      { activity, activityTotal, activityUnset, updatedAt: new Date().toISOString() },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("clubs/counts GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
