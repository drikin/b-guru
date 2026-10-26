/* POST /api/agent/voice/handoff — Mac の「スマホで続ける」（スコープ voice、アプリの鍵だけ）。
 * { target: "offkai"|"voice"|"room", mic } → { apiVersion, ok, sent }（sent 0 = 続けられるスマホがない）。
 * 本人のスマホへ知らせを 1 件（docs/device-sync-spec.md）。中身は lib/voice-handoff.ts（Web と共通）。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { requestVoiceHandoff } from "@/lib/voice-handoff";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/voice/handoff", "voice", async (ctx) => {
    requireAppIssued(ctx); // 外部の鍵から本人のスマホへ知らせを出させない
    let input: Record<string, unknown> | null = null;
    try {
      input = await req.json();
    } catch {
      /* 下で 400 */
    }
    const r = await requestVoiceHandoff(ctx.email, input);
    return { status: r.status, body: { apiVersion: AGENT_API_VERSION, ...r.body }, headers: {} };
  });
  return agentJson(out);
}
