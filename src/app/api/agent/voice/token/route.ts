/* POST /api/agent/voice/token — ボイスルームの入室トークン（LiveKit JWT）。スコープ voice。
 * 中身は lib/voice-actions.ts（Web の /api/voice/token と共通）: 発行のたびに Ghost で
 * 有料会員かを確かめ直し、入室禁止なら 403。トークンは 2 分・この部屋だけ・マイクだけ。 */
import { NextRequest } from "next/server";
import { AgentAuthError, withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { issueVoiceJoin } from "@/lib/voice-actions";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/voice/token", "voice", async (ctx) => {
    const r = await issueVoiceJoin(ctx.email, ctx.userId);
    // Membership ended: the agent layer's own error (same as the rest of /api/agent).
    if (r.body.code === "membership_ended") throw new AgentAuthError(403, r.body as never);
    return { status: r.status, body: r.status === 200 ? { apiVersion: AGENT_API_VERSION, ...r.body } : r.body, headers: {} };
  });
  return agentJson(out);
}
