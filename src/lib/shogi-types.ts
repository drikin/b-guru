/* ☗ 将棋の API・配信の形（サーバ・Web・アプリの約束。snake_case、メールは載せない）。
 * 追加は自由、意味を変えるときは AGENT_API_VERSION と同じ扱い（docs/shogi-spec.md）。 */
import type { EndReason, ShogiResult, Side } from "./shogi-rules";
import type { ShogiMode, ShogiStatus } from "./shogi-clock";

export type ShogiPlayerDto = { user_id: string; name: string; avatar: string | null };

export type ShogiGameDto = {
  id: number;
  status: ShogiStatus;
  mode: ShogiMode;
  /** 申し込んだ人（募集・指名の主）。 */
  creator: ShogiPlayerDto;
  /** 指名の相手（募集なら null）。 */
  invitee: ShogiPlayerDto | null;
  /** 先手・後手（振り駒は受けたときに決まる。それまで null）。 */
  black: ShogiPlayerDto | null;
  white: ShogiPlayerDto | null;
  sfen: string;
  ply: number;
  /** 手番（active でないときも ply から決まる値）。 */
  turn: Side;
  last_move: { usi: string; label: string } | null;
  /** 速い将棋の時計（ゆっくりは null）。手番側の残りは turn_started_at からの経過を引いて出す。 */
  clocks: { black_ms: number; white_ms: number; byoyomi_ms: number; initial_ms: number } | null;
  turn_started_at: string | null;
  /** active: 手番側が時間切れ／中断／放置になる時刻。open/offered: 期限切れの時刻。 */
  deadline_at: string | null;
  /** サーバの時刻（時計の表示はこれとの差で補正する）。 */
  server_now: string;
  spectators: number;
  result: ShogiResult | null;
  end_reason: EndReason | "cancelled" | "declined" | "expired" | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  rematch_of: number | null;
  card_message_id: number | null;
  result_post_id: number | null;
};

export type ShogiMoveDto = { ply: number; usi: string; label: string; sfen: string; spent_ms: number; at: string };

/** ビーグルの実況（1 手ぶん）。SHOGI_COMMENTARY_ENABLED の人にだけ配る（docs/shogi-spec.md「ビーグルの実況」）。 */
export type ShogiCommentaryDto = {
  game_id: number;
  /** どの手の実況か（最新だけ作るので、手が早いと抜ける手がある）。 */
  ply: number;
  /** その手の表記（例 "▲7六歩"）。 */
  move_label: string;
  /** ビーグルの 1〜2 文（全角 60 字程度まで）。 */
  text: string;
  /** 先手から見た評価（歩 = 100。詰み筋は ±9999）。読めなかったら null。帯の形勢の棒に使う。 */
  eval_cp: number | null;
  /** 詰み筋が見えている側（その側の勝ち筋）。 */
  mate: Side | null;
  /** 次の予想手（相手の番のビーグルの最善手）。 */
  best: { usi: string; label: string } | null;
  /** ai = AI（さくらの AI Engine）の文、template = エンジンの事実からのひな形。 */
  source: "ai" | "template";
  /** 見どころ（形勢逆転・詰み筋）。 */
  highlight: "reversal" | "mate" | null;
  at: string;
};

/** GET games/{id} の全体。 */
export type ShogiGameDetailDto = ShogiGameDto & {
  moves: ShogiMoveDto[];
  kif_url: string;
  /** 呼び出した人の色（対局者でなければ null）。 */
  my_color: Side | null;
  /** 最新の実況（実況が有効な人だけ。まだなければ null）。 */
  commentary?: ShogiCommentaryDto | null;
  /** 終局した対局の手ごとの実況（実況が有効な人だけ。棋譜の再生と一緒に見る）。 */
  commentaries?: ShogiCommentaryDto[];
};

/** 配信（Web: /api/posts/stream の `event: shogi`、アプリ: /api/agent/stream の `event: shogi`）。
 *  state = 状態が変わった（指し手・受けた・観戦人数など）、end = 終局、offer = 自分への指名（本人にだけ）。 */
export type ShogiLiveAction = "state" | "end" | "offer";
