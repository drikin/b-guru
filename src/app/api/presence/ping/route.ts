import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensurePresenceSweeper, touch } from "@/lib/presence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/presence/ping — client heartbeat. The SSE stream is the source of
// truth for online/offline, but some browsers kill idle SSE connections. This
// periodic ping refreshes the member's lastSeenAt so the eviction sweep does
// not wrongly drop a healthy-but-quiet connection.
export async function POST(req: NextRequest) {
  ensurePresenceSweeper();
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  touch(email);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}