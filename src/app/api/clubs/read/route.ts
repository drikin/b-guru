import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** ユーザーの既読カーソルを進める（チャット未読と同じ単調増加）。
 *  タイムライン（最新）を表示したらクライアントがこの API を叩き、未読バッジをクリアする。
 *  ボディ: { upToId: number } — この id まで既読にする。
 *  ON CONFLICT GREATEST なので id は単調増加（過去へ戻さない）。 */
export async function POST(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  let upToId: number;
  try {
    const body = await req.json();
    upToId = Number(body?.upToId);
  } catch {
    return NextResponse.json({ error: "不正なリクエスト" }, { status: 400, headers: NO_CACHE });
  }
  if (!Number.isInteger(upToId) || upToId <= 0) {
    return NextResponse.json({ error: "upToId が不正です" }, { status: 400, headers: NO_CACHE });
  }

  try {
    await pool.query(
      `INSERT INTO forum_read_state (email, last_read_id)
            VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE
          SET last_read_id = GREATEST(forum_read_state.last_read_id, EXCLUDED.last_read_id),
              updated_at = now()`,
      [email, upToId]
    );
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/read POST error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
