/* ビーグルエージェント: 共有型定義 */

/** エージェントが実行可能なアクション（サーバー側で検証して実行）。 */
export type BeagleAction =
  | { type: "post"; text: string }
  | { type: "reply"; parentId: number; text: string }
  | { type: "introduce"; email: string; text: string };

/** プロフィール更新の紹介におけるグレース期間。
 *  同一ユーザーはこの期間内に編集を繰り返しても再紹介しない（紹介の連投防止）。 */
export const PROFILE_INTRO_GRACE = "24 hours";

export interface BeagleDecision {
  intent: "none" | "post" | "reply" | "post_and_reply";
  actions: BeagleAction[];
  /** memory.md に追記する学び（@メンション・返信からのフィードバック等）。 */
  learnings: string[];
  /** 次に活動する時刻（JST ISO）。end_null ならサーバーがフォールバック。 */
  next_activity_at: string | null;
  note?: string;
}

/** ニュースソースから正規化された1件。 */
export interface BeagleNewsItem {
  source: string; // 'neta' | 'podcast'
  title: string;
  url: string;
  summary: string;
  publishedAt: string; // ISO
  score?: number;
}

/** タイムライン観測シグナル（空気を読むための材料）。 */
export interface BeagleTimelineSignal {
  /** 直近60分の投稿数。 */
  activityLastHour: number;
  /** 直近7日・同時刻の平均投稿数。 */
  activityAvgHour: number;
  /** 上昇/停滞/下降。 */
  trajectory: "up" | "flat" | "down";
  /** 返信が1件も付いていない直近の root 投稿（孤立ポスト）。 */
  orphanPosts: { id: number; author: string; text: string }[];
  /** コメントが付いて盛り上がっている root 投稿。 */
  hotThreads: { id: number; author: string; text: string; commentCount: number }[];
  /** ビーグルへの言及（@ビーグル / 本文に「ビーグル」/ 自分の投稿への返信）。
   *  explicit: true = 「@ビーグル」と明示的にメンションされた（最優先対応・学習対象）。 */
  mentions: {
    id: number;
    parentId: number | null;
    author: string;
    text: string;
    explicit: boolean;
  }[];
  /** プロフィールを更新したがビーグルがまだ紹介していない人（紹介対象）。 */
  profileUpdates: {
    email: string;
    name: string;
    bio: string;
    headerImage: string | null;
    updatedAt: string;
  }[];
}

/** beagle_state 行のスナップショット。 */
export interface BeagleState {
  lastTickAt: string | null;
  nextActivityAt: string | null;
  enabled: boolean;
  memoryBytes: number;
  postedNews: string[];
  /** ビーグルが既に返信/反応した投稿ID（重複返信防止）。 */
  respondedPosts: number[];
}

/** runBeagleTick の結果。 */
export interface BeagleTickResult {
  mode: "dry" | "live";
  decision: BeagleDecision | null;
  postedIds: number[];
  logId: number | undefined;
  disabled?: boolean;
}
