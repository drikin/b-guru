/* /api/watch/* — 📺 YouTube 共同鑑賞（Web、ログインのセッション）。道順と応答の形は lib/watch-api.ts。
 * WATCH_ENABLED で出していない人には 404。操作は 1 人 1 分 60 回まで（lib/watch.ts の webRateOk）。 */
import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { watchEnabledFor, webRateOk } from "@/lib/watch";
import { handleWatch, notFound, readJsonLimited, type WatchHttpOut } from "@/lib/watch-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function respond(out: WatchHttpOut): Response {
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json", ...NO_STORE } });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const email = await getSessionEmail();
  if (!email) return respond({ status: 401, body: { error: "ログインが必要です", code: "unauthorized" } });
  if (!watchEnabledFor(email)) return respond(notFound());
  const { path } = await ctx.params;
  const userId = await ensureUserId(email);
  if (req.method === "POST" && !webRateOk(userId)) {
    return respond({ status: 429, body: { error: "操作が多すぎます。少し待ってください", code: "rate_limited" } });
  }
  return respond(await handleWatch(req.method, path ?? [], { email, userId }, () => readJsonLimited(req)));
}

export const GET = handle;
export const POST = handle;
