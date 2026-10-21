/* 🎮 散財ダッシュ — サーバ・Web・アプリの橋渡しで共通の形（snake_case。docs/minigame-spec.md が正）。 */

export type MinigameMode = "daily" | "free";
export type MinigamePeriod = "today" | "week" | "all";

/** POST plays の返事（1 回限り・30 分で期限切れ）。 */
export type PlayTicket = {
  play_id: number;
  seed: number;
  mode: MinigameMode;
  character: string;
  engine_version: number;
  /** 今日のチャレンジの日付（JST、5 時区切り）。自由プレイは null。 */
  date: string | null;
  expires_at: string;
};

export type BestDto = { score: number; distance: number; rank: number | null; play_id: number; character: string; achieved_at: string };

export type LeaderEntry = {
  rank: number;
  user_id: string;
  name: string;
  avatar: string | null;
  score: number;
  distance: number;
  character: string;
  achieved_at: string;
};

export type LeaderboardDto = {
  period: MinigamePeriod;
  mode: MinigameMode | null;
  /** today: 日付（YYYY-MM-DD）、week: 週の始め（月曜）、all: null */
  key: string | null;
  entries: LeaderEntry[];
  me: { rank: number; score: number; distance: number } | null;
};

/** GET me の返事の中身（ゲームの「情報」）。 */
export type MinigameInfo = {
  engine_version: number;
  me: { user_id: string; name: string };
  daily: { date: string; seed: number; resets_at: string };
  best: { today: BestDto | null; week: BestDto | null; all: BestDto | null };
  plays_today: number;
  top_today: LeaderEntry | null;
};

/** POST plays/{id}/finish の返事。 */
export type FinishResultDto = {
  play_id: number;
  mode: MinigameMode;
  score: number;
  distance: number;
  sd: number;
  ticks: number;
  cause: string;
  /** 自分のベスト（今日のチャレンジ = 今日の、自由 = 今週の） */
  best: number;
  new_best: boolean;
  /** その遊び方の順位（今日のチャレンジ = 今日、自由 = 今週） */
  rank: number | null;
  period: MinigamePeriod;
  /** 今日のチャレンジの順位（自由プレイなら null） */
  rank_today: number | null;
  /** 今日（JST 5 時区切り）記録した回数 */
  plays_today: number;
  /** 今日 20 回を超えた最初の 1 回だけ true（ビーグルが「ちょっと休憩するわん」） */
  rest_hint: boolean;
  /** 申告値がサーバの再生と違った（記録はサーバの値） */
  mismatch: boolean;
};

/** 配信（SSE）の minigame イベント。 */
export type MinigameLiveEvent =
  | { action: "leaderboard"; period: "today"; key: string; top: LeaderEntry[] }
  | { action: "best"; best: { mode: MinigameMode; score: number; distance: number; rank: number | null; period: MinigamePeriod } };
