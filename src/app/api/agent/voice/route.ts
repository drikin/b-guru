/* GET /api/agent/voice — ボイスルームの今の状態（誰が入っているか）。スコープ read。
 * 入っていない人がチャット画面に「🎙 N 人が話しています［参加］」を出すために使う。
 * 以降の変化は /api/agent/stream の voice イベントで届く。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION, toAgentVoiceDto } from "@/lib/agent-chat";
import { getVoiceState, voiceEnabledFor } from "@/lib/voice";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/voice", "read", async (ctx) => {
    const enabled = voiceEnabledFor(ctx.email);
    const state = enabled ? await getVoiceState() : null;
    return {
      status: 200,
      body: { apiVersion: AGENT_API_VERSION, enabled, room: state ? toAgentVoiceDto(state) : null },
      headers: {},
    };
  });
  return agentJson(out);
}
