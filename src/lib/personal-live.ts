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
  /** 🎮 締め切りダッシュ: 自分のベストが更新された（本人だけ）。 */
  | {
      type: "minigame";
      action: "best";
      best: { mode: MinigameMode; score: number; distance: number; rank: number | null; period: MinigamePeriod };
    };

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
