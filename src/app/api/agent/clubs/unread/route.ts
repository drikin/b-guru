/* GET /api/agent/clubs/unread → { apiVersion, days, unread: { key: n }, counts: [{ club, n }] }（スコープ read）
 * 部活ごとのまだ読んでいない投稿（ほかの人のルート投稿・直近 days 日・NG ワードで隠れるものは除く）。
 * 0 の部活は入らない。未設定は "__unset__"。lib/club-user-order.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { UNREAD_DAYS, getClubUnreadCounts } from "@/lib/club-user-order";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// `counts` は同じ中身の配列（[{ club, n }]）: Swift の JSONDecoder（convertFromSnakeCase）は辞書のキーも
// 書き換える（"my_club" → "myClub"）ので、アプリはこちらを読む。
export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/clubs/unread", "read", async (ctx) => {
    const unread = await getClubUnreadCounts(ctx.email);
    const counts = Object.entries(unread).map(([club, n]) => ({ club, n }));
    return { status: 200, body: { apiVersion: 1, days: UNREAD_DAYS, unread, counts }, headers: {} };
  });
  return agentJson(out);
}
