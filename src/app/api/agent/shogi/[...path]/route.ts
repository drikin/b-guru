/* /api/agent/shogi/* — ☗ 将棋（アプリ）。読む（GET）はスコープ read、操作（POST）は chat。
 * 操作のレート制限は将棋用の枠（agent-auth.ts の BUCKET_RATE_RULES.shogi）。チャットの枠は減らさない。
 * 道順と応答の形は lib/shogi-api.ts（Web の /api/shogi/* と同じ）。SHOGI_ENABLED で出していない人には 404。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { ensureShogiSweeper, shogiEnabledFor } from "@/lib/shogi";
import { handleShogi, notFound } from "@/lib/shogi-api";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const read = req.method === "GET";
  let text: { body: string; headers: Record<string, string> } | null = null;
  const out = await withAgent(
    req,
    `${req.method} /api/agent/shogi`,
    read ? "read" : "chat",
    async (agent) => {
      if (!shogiEnabledFor(agent.email)) return { ...notFound(), headers: {} } as { status: number; body: unknown; headers: Record<string, string> };
      ensureShogiSweeper();
      const r = await handleShogi(req.method, path ?? [], { email: agent.email, userId: agent.userId }, req.nextUrl.searchParams, async () => {
        try {
          const b = await req.json();
          return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      });
      if ("text" in r) {
        text = { body: r.text, headers: r.headers };
        return { status: r.status, body: null, headers: {} };
      }
      return { status: r.status, body: r.body, headers: r.headers ?? {} };
    },
    read ? {} : { rateBucket: "shogi" }
  );
  const t = text as { body: string; headers: Record<string, string> } | null;
  if (t && out.status === 200) return new Response(t.body, { status: 200, headers: { ...NO_CACHE, ...t.headers } });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE, ...(out.headers ?? {}) },
  });
}

export const GET = handle;
export const POST = handle;
