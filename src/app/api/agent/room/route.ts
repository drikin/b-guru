/* GET /api/agent/room — 部室のマップといる人（スコープ read）。
 * POST /api/agent/room — { action: "enter" | "text" | "move" | "voice" | "react", … }（スコープ chat）。
 * 中身は lib/room-api.ts（Web の /api/room と共通）。変化は /api/agent/stream の room イベントで届く。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { roomGet, roomPost } from "@/lib/room-api";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/room", "read", async (ctx) => {
    const r = await roomGet(ctx.email, "agent");
    return { status: r.status, body: { apiVersion: AGENT_API_VERSION, ...r.body }, headers: {} };
  });
  return agentJson(out);
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/room", "chat", async (ctx) => {
    let body: Record<string, unknown> | null = null;
    try {
      body = await req.json();
    } catch {
      /* 400 below */
    }
    const r = await roomPost(ctx.email, body, "agent");
    return { status: r.status, body: { apiVersion: AGENT_API_VERSION, ...r.body }, headers: {} };
  }, { ownRateLimit: true }); // per step while walking: lib/room.ts limits it (12/s)
  return agentJson(out);
}
