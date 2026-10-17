/* POST /api/agent/voice/report — 参加者を管理者に通報する。スコープ voice。
 *   { user_id, reason? }
 * 中身は lib/voice-actions.ts（Web の /api/voice/report と共通）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { reportVoice } from "@/lib/voice-actions";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/voice/report", "voice", async (ctx) => {
    let input: Record<string, unknown>;
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const r = await reportVoice(ctx.email, ctx.userId, input);
    return { status: r.status, body: r.body, headers: {} };
  });
  return agentJson(out);
}
