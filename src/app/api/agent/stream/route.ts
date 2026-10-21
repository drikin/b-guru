/* GET /api/agent/stream — ネイティブアプリ用の個人宛て SSE（スコープ read）。
 *
 * /api/posts/stream との違い:
 *   - presence に影響しない（接続しても「オンライン」にならない）。常駐アプリが
 *     つなぎっぱなしでも在席表示が嘘にならない。在席は見えているときだけ
 *     /api/presence/ping 側で送る想定。
 *   - 閲覧者ごとに変換したイベントを送る: chat の is_author / mentions_me、
 *     自分宛ての notification（personal-live.ts 経由・他人には流れない）。
 *   - タイムラインのイベントは流さない（チャットアプリに不要）。
 *
 * イベント: ready（接続直後・再接続後の再同期用の未読数と最新 ID）, chat, presence,
 * notification, revoked（トークン失効で切断）。25 秒ごとにコメント行で keep-alive。
 * トークンは 5 分ごとに再検証し、失効・退会なら revoked を送って閉じる。 */
import { NextRequest } from "next/server";
import { liveBus, type LiveEvent } from "@/lib/live";
import { personalBus, personalKey, type PersonalEvent } from "@/lib/personal-live";
import { ensureChatSweeper, getLatestChatId, getUnreadCount } from "@/lib/chat";
import { ensurePresenceSweeper } from "@/lib/presence";
import { roomConnect, roomDisconnect, roomEnabledFor } from "@/lib/room";
import { AgentAuthError, verifyAgentToken, withAgent, type AgentContext } from "@/lib/agent-auth";
import {
  AGENT_API_VERSION,
  chatViewerFor,
  liveToStreamEvent,
  toAgentNotificationDto,
  type ChatViewer,
  type StreamEvent,
} from "@/lib/agent-chat";
import { agentJson } from "../_lib";
import { clientIp } from "@/lib/client-ip";
import { shogiEnabledFor } from "@/lib/shogi";
import { minigameEnabledFor } from "@/lib/minigame";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const encoder = new TextEncoder();
const HEARTBEAT_MS = 25_000;
const REVERIFY_MS = 5 * 60_000;
const VIEWER_REFRESH_MS = 10 * 60_000;
/** 1 トークンあたりの同時接続上限（単一プロセスなのでメモリで数える）。 */
const MAX_STREAMS_PER_TOKEN = 3;
const openStreams = new Map<number, number>();

export async function GET(req: NextRequest) {
  let ctx: AgentContext | null = null;
  const gate = await withAgent(req, "GET /api/agent/stream", "read", async (c) => {
    ctx = c;
    // 判定と予約を同じ同期区間で行う（間に await を挟むと並列リクエストで上限を超える）。
    const current = openStreams.get(c.tokenId) ?? 0;
    if (current >= MAX_STREAMS_PER_TOKEN) {
      return {
        status: 429,
        body: { error: "同時接続数の上限です", code: "rate_limited", hint: "古い接続を閉じてください" },
        headers: {},
      };
    }
    openStreams.set(c.tokenId, current + 1);
    return { status: 200, body: null, headers: {} };
  });
  if (gate.status !== 200 || !ctx) return agentJson(gate);
  const agent: AgentContext = ctx;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (openStreams.get(agent.tokenId) ?? 1) - 1;
    if (n <= 0) openStreams.delete(agent.tokenId);
    else openStreams.set(agent.tokenId, n);
  };

  ensureChatSweeper();
  ensurePresenceSweeper();

  const authHeader = req.headers.get("authorization");
  const ip = clientIp(req);
  let viewer: ChatViewer;
  try {
    viewer = await chatViewerFor(agent.email, agent.userId);
  } catch {
    viewer = { userId: agent.userId, mentionNames: new Set() };
  }

  let closed = false;
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  const timers: ReturnType<typeof setInterval>[] = [];
  const key = personalKey(agent.email);

  const write = (chunk: string) => {
    if (closed || !controllerRef) return;
    try {
      controllerRef.enqueue(encoder.encode(chunk));
    } catch {
      teardown();
    }
  };
  const send = (ev: StreamEvent) => write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);

  const roomOn = roomEnabledFor(agent.email);
  const shogiOn = shogiEnabledFor(agent.email);
  const minigameOn = minigameEnabledFor(agent.email);
  const onLive = (ev: LiveEvent) => {
    if (ev.type === "room" && !roomOn) return; // the club room: only for members who have it
    if (ev.type === "shogi" && !shogiOn) return; // ☗ 将棋: behind SHOGI_ENABLED
    if (ev.type === "minigame" && !minigameOn) return; // 🎮 締め切りダッシュ: behind MINIGAME_ENABLED
    const out = liveToStreamEvent(ev, viewer);
    if (out) send(out);
  };
  const onPersonal = (ev: PersonalEvent) => {
    if (ev.type === "notification") {
      send({ event: "notification", data: { notification: toAgentNotificationDto(ev.notification) } });
    } else if (ev.type === "shogi" && shogiOn) {
      // An offer to me (or a change to an offer only the two of us see): same shape as the broadcast.
      send({ event: "shogi", data: { action: ev.action, game: ev.game } });
    } else if (ev.type === "minigame" && minigameOn) {
      // My own best changed (only to me).
      send({ event: "minigame", data: { action: ev.action, best: ev.best } });
    }
  };

  function teardown() {
    if (closed) return;
    closed = true;
    liveBus.off("change", onLive);
    personalBus.off(key, onPersonal);
    roomDisconnect(agent.email);
    for (const t of timers) clearInterval(t);
    release();
    try {
      controllerRef?.close();
    } catch {
      /* already closed */
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;
      liveBus.on("change", onLive);
      personalBus.on(key, onPersonal);
      void roomConnect(agent.email).catch((e) => console.error("[room] connect:", (e as Error)?.message));

      void Promise.all([getUnreadCount(agent.email), getLatestChatId()]).then(
        ([unread, latest]) =>
          send({
            event: "ready",
            data: { apiVersion: AGENT_API_VERSION, chat: { unread_count: unread, latest_id: latest } },
          }),
        () => send({ event: "ready", data: { apiVersion: AGENT_API_VERSION } })
      );

      timers.push(setInterval(() => write(": heartbeat\n\n"), HEARTBEAT_MS));
      timers.push(
        setInterval(async () => {
          try {
            await verifyAgentToken(authHeader, { ip });
          } catch (e) {
            // 切るのは失効・退会（401/403）だけ。Ghost 障害（502）や、同じ NAT の
            // 他人の失敗で当たる認証前レート制限（429）では切らず、次回再検証する。
            if (!(e instanceof AgentAuthError) || (e.status !== 401 && e.status !== 403)) return;
            const code = e.body.code;
            send({ event: "revoked", data: { code } });
            teardown();
          }
        }, REVERIFY_MS)
      );
      timers.push(
        setInterval(async () => {
          viewer = await chatViewerFor(agent.email, agent.userId).catch(() => viewer);
        }, VIEWER_REFRESH_MS)
      );
    },
    cancel() {
      teardown();
    },
  });

  req.signal.addEventListener("abort", teardown);
  // 登録より前に切断されていた場合 abort は二度と発火しないので、ここで片付ける。
  if (req.signal.aborted) teardown();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
