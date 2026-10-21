/* /api/agent/minigame/* — 🎮 締め切りダッシュ（アプリ）。読む（GET）はスコープ read、操作（POST）は chat。
 * 操作のレート制限はミニゲーム用の枠（agent-auth.ts の BUCKET_RATE_RULES.minigame）。チャットの枠は減らさない。
 * 道順と応答の形は lib/minigame-api.ts（Web の /api/minigame/* と同じ）。MINIGAME_ENABLED で出していない人には 404。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { ensureMinigameSweeper, minigameEnabledFor } from "@/lib/minigame";
import { handleMinigame, notFound, readJsonLimited } from "@/lib/minigame-api";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await ctx.params;
  const read = req.method === "GET";
  const out = await withAgent(
    req,
    `${req.method} /api/agent/minigame`,
    read ? "read" : "chat",
    async (agent) => {
      if (!minigameEnabledFor(agent.email)) return { ...notFound(), headers: {} };
      ensureMinigameSweeper();
      const r = await handleMinigame(req.method, path ?? [], { email: agent.email, userId: agent.userId }, req.nextUrl.searchParams, () =>
        readJsonLimited(req)
      );
      return { status: r.status, body: r.body, headers: {} };
    },
    read ? {} : { rateBucket: "minigame" }
  );
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE, ...(out.headers ?? {}) },
  });
}

export const GET = handle;
export const POST = handle;
