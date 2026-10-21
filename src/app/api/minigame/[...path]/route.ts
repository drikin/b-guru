/* /api/minigame/* — 🎮 締め切りダッシュ（Web、ログインのセッション）。道順と応答の形は lib/minigame-api.ts。
 * MINIGAME_ENABLED で出していない人には 404（機能がないのと同じに見える）。 */
import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { ensureMinigameSweeper, minigameEnabledFor } from "@/lib/minigame";
import { handleMinigame, notFound, readJsonLimited, type MinigameHttpOut } from "@/lib/minigame-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function respond(out: MinigameHttpOut): Response {
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json", ...NO_STORE } });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const email = await getSessionEmail();
  if (!email) return respond({ status: 401, body: { error: "ログインが必要です", code: "unauthorized" } });
  if (!minigameEnabledFor(email)) return respond(notFound());
  ensureMinigameSweeper();
  const { path } = await ctx.params;
  const userId = await ensureUserId(email);
  const out = await handleMinigame(req.method, path ?? [], { email, userId }, req.nextUrl.searchParams, () => readJsonLimited(req));
  return respond(out);
}

export const GET = handle;
export const POST = handle;
