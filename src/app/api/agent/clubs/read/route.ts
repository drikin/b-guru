/* POST /api/agent/clubs/read { club? } → { apiVersion, club, marked }（スコープ read_state）
 * 部活ひとつ（club。未設定は "__unset__"）か、club なしで全部を既読にする。直近 30 日のほかの人の投稿を
 * 返信も含めて。lib/club-user-order.ts の markClubRead。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { markClubRead } from "@/lib/club-user-order";
import { agentJson, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/clubs/read", "read_state", async (ctx) => {
    const body = (await readJson(req)) ?? {};
    const raw = typeof body.club === "string" ? body.club.trim() : "";
    if (raw && !/^[a-z0-9_-]{1,40}$/.test(raw)) {
      return { status: 400, body: { error: "不正な部活キーです", code: "invalid_request" }, headers: {} };
    }
    const club = raw || null;
    const marked = await markClubRead(ctx.email, club);
    return { status: 200, body: { apiVersion: 1, club, marked }, headers: {} };
  });
  return agentJson(out);
}
