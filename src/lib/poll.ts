/**
 * 投稿アンケート（投票）の純ロジック。
 * DB アクセスを一切含まない（含めるなら lib/poll.ts でなく別モジュールにする）。
 * FeedPost.poll の型定義と、入力バリデーション・統計組み立て・締切/編集期限判定を提供。
 * クライアント（page.tsx）からは `import type` で参照する（pg を引き込まない）。
 */

export type PollOptionView = {
  id: number;
  label: string;
  votes: number;
  pct: number; // 0..100
};

export type PostPoll = {
  question: string;
  endsAt: string; // ISO
  closed: boolean;
  editable: boolean; // 自分が投稿者 && 投稿後1時間以内（お題編集ボタン表示用）
  totalVotes: number; // 全回答数（総投票数）
  voterCount: number; // 投票者数（1票/投稿 なので totalVotes と同値）
  myVote: number | null; // 自分の現在の option_id
  options: PollOptionView[];
};

/** 締切の選択肢（時間）。drikin 指定: 1h/6h/12h/24h */
export const POLL_DURATIONS = [1, 6, 12, 24] as const;
export const POLL_MIN_OPTIONS = 3;
export const POLL_MAX_OPTIONS = 10;
/** 投稿者がお題（質問/選択肢）を編集できるのは投稿後1時間以内 */
export const POLL_EDIT_WINDOW_MS = 60 * 60 * 1000;
export const POLL_QUESTION_MAX = 200;
export const POLL_LABEL_MAX = 100;

/**
 * 投稿/編集時の入力バリデーション。不正があれば日本語エラー文言、OK なら null。
 */
export function validatePollInput(
  question: unknown,
  options: unknown,
  durationHours?: number
): string | null {
  const q = typeof question === "string" ? question.trim() : "";
  if (!q) return "アンケートの質問を入力してください";
  if (q.length > POLL_QUESTION_MAX) return `質問は${POLL_QUESTION_MAX}文字以内で入力してください`;
  if (!Array.isArray(options)) return "回答（選択肢）を入力してください";
  const labels = options.map((o) => (typeof o === "string" ? o.trim() : "")).filter(Boolean);
  if (labels.length < POLL_MIN_OPTIONS) return `回答は${POLL_MIN_OPTIONS}個以上必要です`;
  if (labels.length > POLL_MAX_OPTIONS) return `回答は最大${POLL_MAX_OPTIONS}個までです`;
  if (labels.some((l) => l.length > POLL_LABEL_MAX)) return `回答は${POLL_LABEL_MAX}文字以内で入力してください`;
  if (durationHours != null && !(POLL_DURATIONS as readonly number[]).includes(durationHours)) {
    return "締切の選択が不正です";
  }
  return null;
}

/** 締切時刻 = 作成時刻 + durationHours（最大24h・プリセットのみ） */
export function endsAtOf(createdAt: Date | string | number, durationHours: number): Date {
  return new Date(new Date(createdAt).getTime() + durationHours * 60 * 60 * 1000);
}

/** 締切済みか（now > ends_at） */
export function isPollClosed(endsAt: Date | string, now: number = Date.now()): boolean {
  return now > new Date(endsAt).getTime();
}

/** 投稿者がお題を編集できるか（投稿後1時間以内） */
export function canEditPoll(createdAt: Date | string, now: number = Date.now()): boolean {
  return now - new Date(createdAt).getTime() < POLL_EDIT_WINDOW_MS;
}

/** カウント群と閲覧者状態から UI 用 PostPoll を組み立てる */
export function buildPostPoll(args: {
  question: string;
  endsAt: Date | string;
  options: { id: number; label: string; votes: number }[];
  myVote: number | null;
  isAuthor: boolean;
  createdAt: Date | string;
  now?: number;
}): PostPoll {
  const now = args.now ?? Date.now();
  const totalVotes = args.options.reduce((s, o) => s + o.votes, 0);
  const options: PollOptionView[] = args.options.map((o) => ({
    id: o.id,
    label: o.label,
    votes: o.votes,
    pct: totalVotes > 0 ? Math.round((o.votes / totalVotes) * 100) : 0,
  }));
  return {
    question: args.question,
    endsAt: new Date(args.endsAt).toISOString(),
    closed: isPollClosed(args.endsAt, now),
    editable: args.isAuthor && canEditPoll(args.createdAt, now),
    totalVotes,
    voterCount: totalVotes, // 1票/投稿 なので合計 = 投票者数
    myVote: args.myVote,
    options,
  };
}
