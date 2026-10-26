/* Per-member event bus for the personal stream (/api/agent/stream).
 *
 * `liveBus` (live.ts) is a broadcast bus: every payload goes verbatim to every
 * client. Events that belong to ONE member (a new notification for them) go
 * here instead, keyed by the member's normalized email, so a listener only
 * ever receives its own events. The email is the routing key only — it is
 * never part of the payload. Single long-lived Node process, as live.ts. */
import { EventEmitter } from "events";
import type { Notification } from "./notifications";
import type { ShogiGameDto, ShogiLiveAction } from "./shogi-types";
import type { MinigameMode, MinigamePeriod } from "./minigame/types";

export type PersonalEvent =
  | { type: "notification"; notification: Notification }
  /** ☗ 将棋: an offer to this member ("offer"), or a change to a game only the two of
   *  them can see (a declined / cancelled / expired offer: "state"). */
  | { type: "shogi"; action: ShogiLiveAction; game: ShogiGameDto }
  /** 🎮 散財ダッシュ: 自分のベストが更新された（本人だけ）。 */
  | {
      type: "minigame";
      action: "best";
      best: { mode: MinigameMode; score: number; distance: number; rank: number | null; period: MinigamePeriod };
    }
  /** ✉️ 簡易 DM（lib/dm.ts）: 受け取る人ごとに作った DTO（メールなし）。そのまま `event: dm` で流す。
   *  { action: "create", message, peer, unread_count? } / { action: "read", peer_id, last_read_id, unread_count } */
  | { type: "dm"; data: Record<string, unknown> }
  /** 既読が進んだ（ほかの端末に残っている同じ知らせを消す合図、docs/device-sync-spec.md）。`event: sync` で流す。 */
  | { type: "sync"; sync: SyncScope };

/** read_sync の範囲（push の本体とストリームの `event: sync` で同じ形）。 */
export type SyncScope =
  | { scope: "chat"; up_to: number }
  | { scope: "dm"; peer_id: string; up_to: number }
  | { scope: "reply"; post_id: number }
  | { scope: "reply_all" }
  | { scope: "shogi"; game_id: number }
  | { scope: "offkai"; event_id: number };

export const personalBus = new EventEmitter();
personalBus.setMaxListeners(0);

export function personalKey(email: string): string {
  return `u:${(email || "").trim().toLowerCase()}`;
}

export function emitPersonal(email: string, event: PersonalEvent): void {
  if (!email) return;
  try {
    personalBus.emit(personalKey(email), event);
  } catch (e) {
    console.error("emitPersonal error:", (e as Error)?.message);
  }
}
