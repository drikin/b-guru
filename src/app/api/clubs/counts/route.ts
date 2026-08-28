import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活ごとのルート投稿件数＋ユーザーごとの未読数（左サイドバー「部活」バッジ用）。
 *  未読 = ルート投稿のうち id > ユーザーの既読カーソル(forum_read_state.last_read_id) のもの。
 *  チャット未読(chat_read_state)と同じ考え方: タイムラインを見るとカーソルが進み未読が消える。
 *  応答: { total, unset, counts, unread, unreadTotal, unreadUnset, lastReadId, maxId, updatedAt }
 *  - counts  : 部活ごとの総件数（バッジは未読のみ表示するが API には両方載せる）
 *  - unread  : 部活ごとの未読数（club 付きルート投稿のみ）
 *  - unreadTotal : 全ルート投稿の未読数（club NULL / __unset__ 含む）
 *  - unreadUnset  : __unset__ の未読数
 *  - lastReadId   : このユーザーの既読カーソル
 *  - maxId        : 最新ルート投稿 id（クライアントが既読マークの基準にする）
 *  ユーザー入力なし・全クエリ静的 → SQLインジェクションなし。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  try {
    // ① ユーザーの既読カーソルを先に取得（未読クエリの基準に使う）
    const readRes = await pool.query(
      `SELECT COALESCE((SELECT last_read_id FROM forum_read_state WHERE email = $1), 0)::int AS last_read`,
      [email]
    );
    const lastReadId = (readRes.rows[0] as { last_read: number }).last_read;

    // ② 残りを並列実行
    const [clubRes, totalRes, unreadClubRes, unreadTotalRes, maxRes] = await Promise.all([
      pool.query(
        `SELECT p.club AS club, count(*)::int AS n
           FROM posts p
          WHERE p.parent_id IS NULL AND p.club IS NOT NULL
          GROUP BY p.club`
      ),
      pool.query(`SELECT count(*)::int AS total FROM posts WHERE parent_id IS NULL`),
      // 部活ごとの未読（club 付きルート投稿のみ）
      pool.query(
        `SELECT p.club AS club, count(*)::int AS n
           FROM posts p
          WHERE p.parent_id IS NULL AND p.club IS NOT NULL AND p.id > $1
          GROUP BY p.club`,
        [lastReadId]
      ),
      // 全ルート投稿の未読
      pool.query(`SELECT count(*)::int AS n FROM posts WHERE parent_id IS NULL AND id > $1`, [lastReadId]),
      // 最新ルート投稿 id
      pool.query(`SELECT COALESCE(max(id),0)::int AS max FROM posts WHERE parent_id IS NULL`),
    ]);

    const counts: Record<string, number> = {};
    for (const row of clubRes.rows as { club: string; n: number }[]) {
      counts[row.club] = row.n;
    }
    const unread: Record<string, number> = {};
    for (const row of unreadClubRes.rows as { club: string; n: number }[]) {
      unread[row.club] = row.n;
    }
    const total = (totalRes.rows[0] as { total: number }).total;
    const unset = counts["__unset__"] ?? 0;
    const unreadTotal = (unreadTotalRes.rows[0] as { n: number }).n;
    const unreadUnset = unread["__unset__"] ?? 0;
    const maxId = (maxRes.rows[0] as { max: number }).max;

    return NextResponse.json(
      { total, unset, counts, unread, unreadTotal, unreadUnset, lastReadId, maxId, updatedAt: new Date().toISOString() },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("clubs/counts GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
