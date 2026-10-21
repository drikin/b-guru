/* 🎮 散財ダッシュ — ゲームの部品とサーバの間の窓口の形（Web は fetch、アプリは橋渡しで中継）。
 * Web の main の束に game.ts（描画・ドット絵）を入れないため、ここだけ別にしてある。 */
import type { Character } from "./sim";
import type { FinishResultDto, LeaderboardDto, MinigameMode, MinigamePeriod, PlayTicket } from "./types";

export type HapticKind = "hit" | "powerup" | "dead" | "highscore" | "select";

export type FinishPayload = {
  play_id: number;
  inputs: number[];
  engine_version: number;
  mode: MinigameMode;
  character: string;
  score: number;
  ticks: number;
  distance: number;
  sd: number;
};

export class HostError extends Error {
  constructor(
    message: string,
    public code: string = "error"
  ) {
    super(message);
  }
}

export interface GameHost {
  requestPlay(mode: MinigameMode, character: Character): Promise<PlayTicket>;
  finish(p: FinishPayload): Promise<FinishResultDto>;
  leaderboard(period: MinigamePeriod): Promise<LeaderboardDto>;
  /** 情報（GET me）を取り直してほしい（日付が替わったときなど）。 */
  refresh?(): void;
  haptic?(kind: HapticKind): void;
  resized?(height: number): void;
}

