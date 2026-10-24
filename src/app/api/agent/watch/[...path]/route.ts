/* /api/agent/watch/* — 📺 YouTube 共同鑑賞（アプリ）。読む（GET）はスコープ read、操作（POST）は chat。
 * 操作のレート制限は共同鑑賞用の枠（agent-auth.ts の BUCKET_RATE_RULES.watch）。チャットの枠は減らさない。
 * 道順と応答の形は lib/watch-api.ts（Web の /api/watch/* と同じ）。WATCH_ENABLED で出していない人には 404。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { watchEnabledFor } from "@/lib/watch";
import { handleWatch, notFound, readJsonLimited } from "@/lib/watch-api";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const read = req.method === "GET";
  const out = await withAgent(
    req,
    `${req.method} /api/agent/watch`,
    read ? "read" : "chat",
    async (agent) => {
      if (!watchEnabledFor(agent.email)) return { ...notFound(), headers: {} };
      const r = await handleWatch(req.method, path ?? [], { email: agent.email, userId: agent.userId }, () => readJsonLimited(req));
      return { status: r.status, body: r.body, headers: {} };
    },
    read ? {} : { rateBucket: "watch" }
  );
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE, ...(out.headers ?? {}) },
  });
}

export const GET = handle;
export const POST = handle;
