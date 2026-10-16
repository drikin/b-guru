/* GET /api/agent/members — @メンション補完用の会員一覧（スコープ read）。
 * Web の /api/members と同じ lib（メールアドレスは含めない）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { mentionMembers } from "@/lib/members";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/members", "read", async () => ({
    status: 200,
    body: {
      apiVersion: AGENT_API_VERSION,
      members: (await mentionMembers()).map((m) => ({ user_id: m.userId, name: m.name, avatar: m.avatar })),
    },
    headers: {},
  }));
  return agentJson(out);
}
