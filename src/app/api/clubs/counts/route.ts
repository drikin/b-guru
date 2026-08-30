import { NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

type TrendKey = "up" | "flat" | "down";

/** トレンド判定: 直近24h vs 前日24h（同窓）の件数から ↑/→/↓ を出す。
 *  小さすぎる変動（ジッター）で毎回ひっくり返らないよう、絶対差と比率のハイブリッドで判定。
 *  しきい値は調整可能。 */
function classifyTrend(recent: number, prior: number): TrendKey {
  if (recent === 0 && prior === 0) return "flat";
  if (prior === 0) return "up"; // 前日0件 → 直近で新たに盛り上がり
  if (recent === 0) return "down"; // 前日あったのに直近0件 → 沈静
  const diff = recent - prior;
  const ratio = recent / prior;
  if (diff >= 2 && (diff >= 5 || ratio >= 1.3)) return "up";
  if (diff <= -2 && (diff <= -5 || ratio <= 0.7)) return "down";
  return "flat";
}

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
    const [sevenDayRes, trendRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(NULLIF(r.club, '__unset__'), '__unset__') AS club, count(*)::int AS n
           FROM posts p
           LEFT JOIN posts r ON r.id = COALESCE(p.parent_id, p.id)
          WHERE p.created_at > now() - interval '7 days'
          GROUP BY 1`
      ),
      // 直近24h と 前日24h（同窓）を1クエリで集計。ルートの club に紐付け。
      pool.query(
        `SELECT COALESCE(NULLIF(r.club, '__unset__'), '__unset__') AS club,
                count(*) FILTER (WHERE p.created_at > now() - interval '24 hours')::int AS recent,
                count(*) FILTER (WHERE p.created_at > now() - interval '48 hours'
                                 AND p.created_at <= now() - interval '24 hours')::int AS prior
           FROM posts p
           LEFT JOIN posts r ON r.id = COALESCE(p.parent_id, p.id)
          WHERE p.created_at > now() - interval '48 hours'
          GROUP BY 1`
      ),
    ]);

    // ---- アクティビティ（直近7日） ----
    const activity: Record<string, number> = {};
    for (const row of sevenDayRes.rows as { club: string; n: number }[]) {
      activity[row.club] = row.n;
    }
    const activityUnset = activity["__unset__"] ?? 0;
    delete activity["__unset__"]; // 未設定は activityUnset として別返却
    const activityTotal =
      (Object.values(activity) as number[]).reduce((s, n) => s + n, 0) + activityUnset;

    // ---- トレンド（直近24h vs 前日24h） ----
    const trend: Record<string, TrendKey> = {};
    let recentTotal = 0;
    let priorTotal = 0;
    let recentUnset = 0;
    let priorUnset = 0;
    for (const row of trendRes.rows as { club: string; recent: number; prior: number }[]) {
      if (row.club === "__unset__") {
        recentUnset = row.recent;
        priorUnset = row.prior;
        continue;
      }
      trend[row.club] = classifyTrend(row.recent, row.prior);
      recentTotal += row.recent;
      priorTotal += row.prior;
    }
    recentTotal += recentUnset;
    priorTotal += priorUnset;
    const trendTotal = classifyTrend(recentTotal, priorTotal);
    const trendUnset = classifyTrend(recentUnset, priorUnset);

    return NextResponse.json(
      { activity, activityTotal, activityUnset, trend, trendTotal, trendUnset, updatedAt: new Date().toISOString() },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("clubs/counts GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
