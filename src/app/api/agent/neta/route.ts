/* POST /api/agent/neta { url, title, description? } — 投稿が参照している記事を BS ネタ帳に送る
 * （スコープ post）。投稿者名は会員の B-guru の表示名。中身は lib/neta.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { resolveDisplayNames } from "@/lib/display-name";
import { normalizeNetaInput, submitToNeta } from "@/lib/neta";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/neta", "post", async (ctx) => {
    const body = await req.json().catch(() => null);
    const input = normalizeNetaInput(body);
    if (!input.ok) return { status: 400, body: { error: input.error, code: "invalid" }, headers: {} };
    const name = (await resolveDisplayNames([ctx.email])).get(ctx.email) || "B-guru 会員";
    const r = await submitToNeta(input.value, name);
    return { status: r.status, body: { apiVersion: AGENT_API_VERSION, ...r.body }, headers: {} };
  });
  return agentJson(out);
}
