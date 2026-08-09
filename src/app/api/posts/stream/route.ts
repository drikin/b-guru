import { NextRequest } from "next/server";
import { liveBus, LiveEvent } from "@/lib/live";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();

// GET /api/posts/stream — Server-Sent Events stream of timeline changes.
// Sends an initial "ready" ping, then pushes a JSON {type, postId, action}
// message whenever any timeline mutation happens elsewhere in this process.
export async function GET(req: NextRequest) {
  let send: (event: LiveEvent | { type: "ping" }) => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;

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
      liveBus.off("change", send);
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  req.signal.addEventListener("abort", () => {
    liveBus.off("change", send);
    if (heartbeat) clearInterval(heartbeat);
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}