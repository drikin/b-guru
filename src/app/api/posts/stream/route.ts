import { NextRequest } from "next/server";
import { liveBus, LiveEvent } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import {
  ensurePresenceSweeper,
  getOnlineEmails,
  markOffline,
  markOnline,
} from "@/lib/presence";
import { ensureChatSweeper } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

// GET /api/posts/stream — Server-Sent Events stream of timeline changes.
// Sends an initial "ready" ping, then pushes a JSON {type, postId, action}
// message whenever any timeline mutation happens elsewhere in this process.
// Also drives the realtime presence panel: opening this stream marks the
// logged-in member online, and closing it marks them offline.
export async function GET(req: NextRequest) {
  ensurePresenceSweeper();
  ensureChatSweeper();
  const email = await getSessionEmail();

  let send: (event: LiveEvent | { type: "ping" }) => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let disconnected = false;

  // Guard against duplicate teardown: both the stream's cancel() and the
  // request's abort event can fire on disconnect, which would over-decrement
  // the member's presence connection count.
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (email) markOffline(email);
    liveBus.off("change", send);
    if (heartbeat) clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (event) => {
        try {
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // stream closed
        }
      };

      if (email) {
        markOnline(email);
        // Send the current online list to this freshly-connected client so the
        // panel renders immediately without waiting for the next change.
        send({ type: "presence", emails: getOnlineEmails() });
      }

      // Initial ping so the client knows the connection is alive.
      send({ type: "ping" });

      // Heartbeat every 25s to keep the connection (and proxies) alive.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          /* ignore */
        }
      }, 25000);

      liveBus.on("change", send);
    },
    cancel() {
      disconnect();
    },
  });

  req.signal.addEventListener("abort", disconnect);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}