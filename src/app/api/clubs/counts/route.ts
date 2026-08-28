import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活ごとのルート投稿件数（左サイドバー「部活」セクションのバッジ用）。
 *  listPosts の club フィルタと同一の「ルート投稿(parent_id IS NULL)」基準で数える。
 *  応答: { total, unset, counts: { <clubKey>: n }, updatedAt }。
 *  counts は件数>0 のもののみ（クライアント側で既知クラブを 0 埋めする）。
 *  __unset__(未設定) も counts に含め、unset に別途まとめる。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  try {
    const [clubRes, totalRes] = await Promise.all([
      pool.query(
        `SELECT p.club AS club, count(*)::int AS n
           FROM posts p
          WHERE p.parent_id IS NULL AND p.club IS NOT NULL
          GROUP BY p.club`
      ),
      pool.query(`SELECT count(*)::int AS total FROM posts WHERE parent_id IS NULL`),
    ]);

    const counts: Record<string, number> = {};
    for (const row of clubRes.rows as { club: string; n: number }[]) {
      counts[row.club] = row.n;
    }
    const total = (totalRes.rows[0] as { total: number }).total;
    const unset = counts["__unset__"] ?? 0;

    return NextResponse.json(
      { total, unset, counts, updatedAt: new Date().toISOString() },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("clubs/counts GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
