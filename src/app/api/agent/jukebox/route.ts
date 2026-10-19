/* GET /api/agent/jukebox — ジュークボックス（backspace.fm の過去回）の全回と今日の 1 本（スコープ read）。
 * 機能フラグ JUKEBOX_ALLOW_EMAILS の会員だけ。中身は lib/jukebox.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { jukeboxEnabledFor, jukeboxForApp } from "@/lib/jukebox";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/jukebox", "read", async (ctx) => {
    if (!jukeboxEnabledFor(ctx.email)) {
      return { status: 404, body: { error: "ジュークボックスはまだ使えません", code: "jukebox_disabled" }, headers: {} };
    }
    const body = await jukeboxForApp();
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...body }, headers: {} };
  });
  return agentJson(out);
}
