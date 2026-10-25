/* /api/agent/offkai/* — 🍻 オフ会（アプリ）。読む（GET）はスコープ read、操作は chat（写真は multipart）。
 * 操作のレート制限はオフ会用の枠（agent-auth.ts の BUCKET_RATE_RULES.offkai）。チャットの枠は減らさない。
 * 道順と応答の形は lib/offkai-api.ts（Web の /api/offkai/* と同じ）。OFFKAI_ENABLED で出していない人には 404。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { offkaiEnabledFor } from "@/lib/offkai";
import { handleOffkai, notFound } from "@/lib/offkai-api";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const read = req.method === "GET";
  const out = await withAgent(
    req,
    `${req.method} /api/agent/offkai`,
    read ? "read" : "chat",
    async (agent) => {
      if (!offkaiEnabledFor(agent.email)) return { ...notFound(), headers: {} };
      const r = await handleOffkai(req, path ?? [], { email: agent.email, userId: agent.userId });
      return { status: r.status, body: r.body, headers: {} };
    },
    read ? {} : { rateBucket: "offkai" }
  );
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE, ...(out.headers ?? {}) },
  });
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
