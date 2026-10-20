/* GET /api/agent/capabilities — このサーバーが今サポートする機能と、呼び出し
 * トークンで使える操作。ネイティブアプリは起動時に読み、無い機能は隠し、
 * 知らない項目は無視する（再配布なしで Web の進化に追従するための契約）。 */
import { roomEnabledFor } from "@/lib/room";
import { jukeboxBrokenClient, jukeboxEnabledFor } from "@/lib/jukebox";
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentCapabilities } from "@/lib/agent-chat";
import { agentJson } from "../_lib";
import { voiceEnabledFor } from "@/lib/voice";
import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/capabilities", null, async (ctx) => ({
    status: 200,
    body: agentCapabilities(ctx.scopes, { voice: voiceEnabledFor(ctx.email), voiceAdmin: isAdmin(ctx.email), room: roomEnabledFor(ctx.email), jukebox: jukeboxEnabledFor(ctx.email) && !jukeboxBrokenClient(req.headers.get("user-agent")) }),
    headers: {},
  }));
  return agentJson(out);
}
