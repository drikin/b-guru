import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensurePresenceSweeper, touch } from "@/lib/presence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/presence/ping — client heartbeat. The SSE stream is the source of
// truth for online/offline, but some browsers kill idle SSE connections. This
// periodic ping refreshes the member's lastSeenAt so the eviction sweep does
// not wrongly drop a healthy-but-quiet connection.
//
// Body (optional): { visible: boolean } — the Page Visibility API state of the
// tab. The right-sidebar オンライン panel dims members whose tab is open but
// backgrounded, so the client reports this on every ping AND immediately on
// each visibilitychange (see page.tsx). A missing/invalid body leaves the
// stored value untouched rather than guessing.
export async function POST(req: NextRequest) {
  ensurePresenceSweeper();
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  let visible: boolean | undefined;
  try {
    const body = await req.json();
    if (typeof body?.visible === "boolean") visible = body.visible;
  } catch {
    // No body / not JSON — treat as a plain heartbeat.
  }
  touch(email, visible);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
