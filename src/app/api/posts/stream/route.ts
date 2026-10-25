import { NextRequest } from "next/server";
import { toAgentVoiceDto } from "@/lib/agent-chat";
import { roomConnect, roomDisconnect, roomEnabledFor } from "@/lib/room";
import { liveBus, LiveEvent } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import {
  ensurePresenceSweeper,
  getOnlineMembers,
  markOffline,
  markOnline,
} from "@/lib/presence";
import { ensureChatSweeper } from "@/lib/chat";
import { ensureTrendSweeper } from "@/lib/trends";
import { personalBus, personalKey, type PersonalEvent } from "@/lib/personal-live";
import { shogiEnabledFor } from "@/lib/shogi";
import { commentaryEnabledFor } from "@/lib/shogi-commentary-store";
import { minigameEnabledFor } from "@/lib/minigame";
import { watchEnabledFor } from "@/lib/watch";
import { ensureOffkaiSweeper, offkaiEnabledFor } from "@/lib/offkai";
import { dmEnabledFor, ensureDmSweeper } from "@/lib/dm";

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
  ensureTrendSweeper();
  const email = await getSessionEmail();
  const roomOn = roomEnabledFor(email);
  // ☗ 将棋: signed-in members with the feature (SHOGI_ENABLED). Offers to me come over the
  // personal bus (the same `event: shogi` shape, action "offer").
  const shogiOn = shogiEnabledFor(email);
  // ☗ ビーグルの実況 (SHOGI_COMMENTARY_ENABLED; the owner first).
  const commentaryOn = commentaryEnabledFor(email);
  // 🎮 散財ダッシュ (MINIGAME_ENABLED): today's top 10 over the broadcast bus, my own best over the personal bus.
  const minigameOn = minigameEnabledFor(email);
  // 📺 共同鑑賞 (WATCH_ENABLED): signed-in members with the feature only.
  const watchOn = !!email && watchEnabledFor(email);
  // 🍻 オフ会 (OFFKAI_ENABLED): signed-in members with the feature only.
  const offkaiOn = !!email && offkaiEnabledFor(email);
  // 再起動のあとも、誰かがつなげば見回り（期限・話す人の離席・後処理のやり直し）が動く。
  if (offkaiOn) ensureOffkaiSweeper();
  // ✉️ 簡易 DM (DM_ENABLED): my DMs and read marks over the personal bus (`event: dm`, per-recipient DTO).
  const dmOn = dmEnabledFor(email);
  if (dmOn) ensureDmSweeper();
  const shogiKey = email && (shogiOn || minigameOn || dmOn) ? personalKey(email) : null;
  let onPersonal: ((ev: PersonalEvent) => void) | null = null;

  let send: (event: LiveEvent | { type: "ping" }) => void = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let disconnected = false;

  // Guard against duplicate teardown: both the stream's cancel() and the
  // request's abort event can fire on disconnect, which would over-decrement
  // the member's presence connection count.
  const disconnect = () => {
    if (disconnected) return;
    disconnected = true;
    if (email) {
      markOffline(email);
      roomDisconnect(email);
    }
    liveBus.off("change", send);
    if (shogiKey && onPersonal) personalBus.off(shogiKey, onPersonal);
    if (heartbeat) clearInterval(heartbeat);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (event) => {
        // Who is in the voice room goes to signed-in members only (this stream is
        // also open to signed-out visitors). Same DTO as the apps: user_id / name / avatar.
        // The club room likewise: signed-in members who have it (rollout flag).
        if (event.type === "room" && !roomOn) return;
        if (event.type === "shogi" && !shogiOn) return;
        if (event.type === "shogi_commentary" && !commentaryOn) return;
        if (event.type === "minigame" && !minigameOn) return;
        if (event.type === "watch" && !watchOn) return;
        if (event.type === "offkai" && !offkaiOn) return;
        // Names / avatars of who is online: signed-in members only (same as
        // GET /api/presence, which returns [] to visitors).
        if (event.type === "presence" && !email && event.members) {
          event = { type: "presence", userIds: event.userIds };
        }
        if (event.type === "voice") {
          if (!email) return;
          try {
            controller.enqueue(encoder.encode(`event: voice\ndata: ${JSON.stringify(toAgentVoiceDto(event.state))}\n\n`));
          } catch {
            // stream closed
          }
          return;
        }
        try {
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // stream closed
        }
      };

      if (email) {
        markOnline(email);
        void roomConnect(email).catch((e) => console.error("[room] connect:", (e as Error)?.message));
        // Send the current online list to this freshly-connected client so the
        // panel renders immediately without waiting for the next change.
        // Opaque user ids only — this used to ship every online member's email
        // address to every client that opened the stream.
        void getOnlineMembers().then((members) => {
          send({ type: "presence", userIds: members.map((m) => m.userId), members });
        });
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
      if (shogiKey) {
        onPersonal = (ev) => {
          if (ev.type === "shogi" ? !shogiOn : ev.type === "minigame" ? !minigameOn : ev.type === "dm" ? !dmOn : true) return;
          try {
            const data = ev.type === "dm" ? ev.data : ev;
            controller.enqueue(encoder.encode(`event: ${ev.type}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            // stream closed
          }
        };
        personalBus.on(shogiKey, onPersonal);
      }
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