import { NextResponse } from "next/server";
import { getClubCounts } from "@/lib/club-counts";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活ごとのアクティビティ（直近7日）＋トレンド（直近24h vs 前日24h）。
 *  左サイドバー「部活」のバッジ（活性度）と盛り上がり矢印（トレンド）用。
 *
 * アクティビティ: 直近7日の投稿+コメント数。コメントは club を持たないため、
 *  ルート投稿（自己JOIN）の club に紐付けて集計。NULL / __unset__ は「未設定」枠。
 * トレンド: 直近24h と 前日24h（同窓）の投稿+コメント数差を ↑/→/↓ に分類。
 *
 * 応答: { activity, activityTotal, activityUnset, trend, trendTotal, trendUnset, updatedAt }
 *  - activity*    : 直近7日メッセージ数（activity=部活別 / Total=全体 / Unset=未設定）
 *  - trend*       : ↑|→|↓ のトレンド（trend=部活別 / Total=全体 / Unset=未設定）
 *  ユーザー入力なし・全クエリ静的 → SQLインジェクションなし。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  try {
    // 全員共通の集計: 45 秒共有・投稿/削除/部活変更で作り直し（lib/club-counts.ts）。
    return NextResponse.json(await getClubCounts(), { headers: NO_CACHE });
  } catch (e: any) {
    console.error("clubs/counts GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
