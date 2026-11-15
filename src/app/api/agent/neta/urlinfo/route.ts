/* GET /api/agent/neta/urlinfo?url= — アプリの「ネタ帳に送る」で、URL から題名と一言を補完する（スコープ post）。
 * 答えは { apiVersion, url, finalUrl?, title, description, note? }。中身は lib/neta-urlinfo.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { fetchNetaUrlInfo, publicHttpUrl, urlInfoRateOk } from "@/lib/neta-urlinfo";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/neta/urlinfo", "post", async (ctx) => {
    const raw = new URL(req.url).searchParams.get("url") ?? "";
    if (!publicHttpUrl(raw)) return { status: 400, body: { error: "URL が正しくありません", code: "invalid" } };
    if (!urlInfoRateOk(`v:${ctx.email}`)) return { status: 429, body: { error: "回数が多すぎます", code: "rate_limited" } };
    const info = await fetchNetaUrlInfo(raw);
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...info } };
  });
  return agentJson(out);
}
