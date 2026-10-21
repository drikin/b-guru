/* GET /api/agent/jukebox — ジュークボックス（backspace.fm の過去回）の全回と今日の 1 本（スコープ read）。
 * 機能フラグ JUKEBOX_ALLOW_EMAILS の会員だけ。中身は lib/jukebox.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { etagMatches, jukeboxAppResponse, jukeboxEnabledFor } from "@/lib/jukebox";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The list is ~1.3 MB and changes only when the feed sync brings new episodes, so it
// is built once in memory (lib/jukebox.ts) and sent with an ETag. A client that sends
// If-None-Match gets 304; one that does not (URLSession / OkHttp without a cache)
// still gets the full 200 as before. "private, no-cache" lets a device keep it and
// revalidate; Vary: Authorization keeps one token's copy from serving another.
export async function GET(req: NextRequest) {
  let payload: { json: string; etag: string } | null = null;
  const out = await withAgent(req, "GET /api/agent/jukebox", "read", async (ctx) => {
    if (!jukeboxEnabledFor(ctx.email)) {
      return { status: 404, body: { error: "ジュークボックスはまだ使えません", code: "jukebox_disabled" }, headers: {} };
    }
    payload = await jukeboxAppResponse(AGENT_API_VERSION);
    if (etagMatches(req.headers.get("if-none-match"), payload.etag)) return { status: 304, body: null, headers: {} };
    return { status: 200, body: null, headers: {} };
  });
  const p = payload as { json: string; etag: string } | null;
  if (!p || (out.status !== 200 && out.status !== 304)) return agentJson(out);
  const headers = { "Cache-Control": "private, no-cache", ETag: p.etag, Vary: "Authorization" };
  if (out.status === 304) return new Response(null, { status: 304, headers });
  return new Response(p.json, { status: 200, headers: { "Content-Type": "application/json", ...headers } });
}
