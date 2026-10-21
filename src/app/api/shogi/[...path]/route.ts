/* /api/shogi/* — ☗ 将棋（Web、ログインのセッション）。道順と応答の形は lib/shogi-api.ts。
 * SHOGI_ENABLED で出していない人には 404（機能がないのと同じに見える）。 */
import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { ensureShogiSweeper, shogiEnabledFor } from "@/lib/shogi";
import { handleShogi, notFound, type ShogiHttpOut } from "@/lib/shogi-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function respond(out: ShogiHttpOut): Response {
  if ("text" in out) return new Response(out.text, { status: out.status, headers: { ...NO_STORE, ...out.headers } });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_STORE, ...(out.headers ?? {}) },
  });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const email = await getSessionEmail();
  if (!email) return respond({ status: 401, body: { error: "ログインが必要です", code: "unauthorized" } });
  if (!shogiEnabledFor(email)) return respond(notFound());
  ensureShogiSweeper();
  const { path } = await ctx.params;
  const userId = await ensureUserId(email);
  const out = await handleShogi(req.method, path ?? [], { email, userId }, req.nextUrl.searchParams, async () => {
    try {
      const b = await req.json();
      return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  });
  return respond(out);
}

export const GET = handle;
export const POST = handle;
