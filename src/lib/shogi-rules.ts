/* ☗ 将棋のルール判定（サーバと盤面部品の共用。DB もブラウザ API も使わない純関数だけ）。
 *
 * ルールの本体は tsshogi 2.3.4（MIT）。二歩・打ち歩詰め・王手放置・行き所のない駒は
 * Position.isValidMove が判定する。ここで足すのは:
 *   - 合法手の一覧（全マスの createMove＋成り・不成＋持ち駒の打ちを isValidMove で絞る）
 *   - 詰みの判定（指し手のない側の負け。王手中で 0 手なら詰み）
 *   - 千日手（同一局面 4 回 → 引き分け）・連続王手の千日手（王手をかけ続けた側の負け）
 *   - 指し手の表記「▲7六歩」と KIF の書き出し
 * 初期局面は平手だけ（任意の SFEN は受け付けない: docs/shogi-spec.md）。 */
import {
  Color,
  PieceType,
  Move,
  Position,
  Record as KifuRecord,
  RecordMetadataKey,
  SpecialMoveType,
  Square,
  exportKIF,
  formatMove,
  type ImmutablePosition,
} from "tsshogi";

export const INITIAL_SFEN = "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

export type Side = "black" | "white";
export type ShogiResult = Side | "draw";

/** 自動で決まる終わり方（指し手の直後に判定する）。 */
export type RuleEnd =
  | { result: Side; reason: "checkmate" }
  | { result: "draw"; reason: "sennichite" }
  | { result: Side; reason: "perpetual_check" };

export function sideOf(c: Color): Side {
  return c === Color.BLACK ? "black" : "white";
}
export function otherSide(s: Side): Side {
  return s === "black" ? "white" : "black";
}
/** 平手は先手から。ply = それまでに指された手数。 */
export function sideToMove(ply: number): Side {
  return ply % 2 === 0 ? "black" : "white";
}

const HAND_TYPES: PieceType[] = [
  PieceType.ROOK,
  PieceType.BISHOP,
  PieceType.GOLD,
  PieceType.SILVER,
  PieceType.KNIGHT,
  PieceType.LANCE,
  PieceType.PAWN,
];

/** 手番側の合法手（tsshogi の Move）。 */
export function legalMovesOf(pos: ImmutablePosition): Move[] {
  const out: Move[] = [];
  const color = pos.color;
  const seen = new Set<string>();
  const push = (m: Move | null) => {
    if (!m) return;
    for (const mm of [m, m.withPromote()]) {
      const key = mm.usi;
      if (seen.has(key)) continue;
      if (pos.isValidMove(mm)) {
        seen.add(key);
        out.push(mm);
      }
    }
  };
  for (const from of pos.board.listNonEmptySquares()) {
    const p = pos.board.at(from);
    if (!p || p.color !== color) continue;
    for (const to of Square.all) push(pos.createMove(from, to));
  }
  const hand = pos.hand(color);
  for (const t of HAND_TYPES) {
    if (hand.count(t) === 0) continue;
    for (const to of Square.all) {
      if (pos.board.at(to)) continue;
      push(pos.createMove(t, to));
    }
  }
  return out;
}

/** SFEN の局面の合法手（USI）。SFEN が不正なら []。 */
export function legalUsi(sfen: string): string[] {
  const pos = Position.newBySFEN(sfen);
  return pos ? legalMovesOf(pos).map((m) => m.usi) : [];
}

/** 「☗７六歩」→「▲7六歩」（全角数字を半角に、「同　」の空白を詰める）。 */
export function normalizeLabel(s: string): string {
  return s
    .replace(/☗/g, "▲")
    .replace(/☖/g, "△")
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/同[\s　]+/, "同");
}

export function moveLabel(before: ImmutablePosition, move: Move, lastMove?: Move | null): string {
  return normalizeLabel(formatMove(before, move, lastMove ? { lastMove } : undefined));
}

/** 局面と USI から表記を作る。lastUsi は「同」の判定だけに使う（tsshogi は直前の手の行き先しか見ない）。 */
export function labelFor(before: ImmutablePosition, usi: string, lastUsi: string | null): string | null {
  const m = before.createMoveByUSI(usi);
  if (!m) return null;
  const lastTo = lastUsi ? Square.newByUSI(lastUsi.slice(2, 4)) : null;
  return normalizeLabel(formatMove(before, m, lastTo ? { lastMove: { to: lastTo } as Move } : undefined));
}

/** USI の文字列として形が正しいか（駒の有無までは見ない）。 */
export const USI_RE = /^(?:[1-9][a-i][1-9][a-i]\+?|[PLNSGBR]\*[1-9][a-i])$/;

export type Replay = {
  record: KifuRecord;
  /** 各手の表記（index = ply - 1）。 */
  labels: string[];
  /** 各手の後の SFEN。 */
  sfens: string[];
};

/** 平手から USI の列を並べ直す。途中で反則があれば Error（DB の正本が壊れていない限り起きない）。 */
export function replay(usis: string[]): Replay | Error {
  const record = new KifuRecord();
  const labels: string[] = [];
  const sfens: string[] = [];
  let last: Move | null = null;
  for (let i = 0; i < usis.length; i++) {
    const pos = record.position;
    const m = pos.createMoveByUSI(usis[i]);
    if (!m || !pos.isValidMove(m)) return new Error(`illegal move at ply ${i + 1}: ${usis[i]}`);
    labels.push(moveLabel(pos, m, last));
    if (!record.append(m)) return new Error(`cannot append ply ${i + 1}`);
    sfens.push(record.position.sfen);
    last = m;
  }
  return { record, labels, sfens };
}

/** 指し手のあとの局面で自動の終局を判定する。
 *  - 千日手（同一局面 4 回）: 連続王手なら王手をかけ続けた側の負け、そうでなければ引き分け
 *  - 手番側に合法手がない: 手番側の負け（王手中なら詰み。打ち歩詰めは isValidMove が先に弾く） */
export function judge(record: KifuRecord): RuleEnd | null {
  if (record.repetition) {
    const checker = record.perpetualCheck;
    if (checker) return { result: otherSide(sideOf(checker)), reason: "perpetual_check" };
    return { result: "draw", reason: "sennichite" };
  }
  const pos = record.position;
  if (legalMovesOf(pos).length === 0) {
    return { result: otherSide(sideOf(pos.color)), reason: "checkmate" };
  }
  return null;
}

export type TryMove =
  | { ok: false; error: "bad_usi" | "illegal" }
  | { ok: true; usi: string; label: string; sfen: string; end: RuleEnd | null };

/** これまでの手（USI）に 1 手足してみる。合法なら新しい局面と自動の終局。 */
export function tryMove(history: string[], usi: string): TryMove {
  if (typeof usi !== "string" || !USI_RE.test(usi)) return { ok: false, error: "bad_usi" };
  const r = replay(history);
  if (r instanceof Error) throw r;
  const pos = r.record.position;
  const m = pos.createMoveByUSI(usi);
  if (!m || !pos.isValidMove(m)) return { ok: false, error: "illegal" };
  const lastNode = history.length > 0 ? r.record.current.move : null;
  const last = lastNode instanceof Move ? lastNode : null;
  const label = moveLabel(pos, m, last);
  r.record.append(m);
  return { ok: true, usi: m.usi, label, sfen: r.record.position.sfen, end: judge(r.record) };
}

export type EndReason =
  | "resign"
  | "checkmate"
  | "timeout"
  | "sennichite"
  | "perpetual_check"
  | "abandon"
  | "aborted";

export const END_REASON_LABEL: Record<EndReason, string> = {
  resign: "投了",
  checkmate: "詰み",
  timeout: "時間切れ",
  sennichite: "千日手",
  perpetual_check: "連続王手の千日手",
  abandon: "放置",
  aborted: "中断",
};

/** KIF（柿木形式）。消費時間・終わり方・対局者名を入れる。 */
export function buildKif(input: {
  usis: string[];
  spentMs: number[];
  blackName: string;
  whiteName: string;
  startedAt: Date | null;
  endedAt: Date | null;
  mode: "blitz" | "slow";
  result: ShogiResult | null;
  endReason: EndReason | null;
}): string {
  const r = replay(input.usis);
  if (r instanceof Error) throw r;
  const rec = new KifuRecord();
  rec.metadata.setStandardMetadata(RecordMetadataKey.TITLE, "B-guru 将棋");
  rec.metadata.setStandardMetadata(RecordMetadataKey.BLACK_NAME, input.blackName);
  rec.metadata.setStandardMetadata(RecordMetadataKey.WHITE_NAME, input.whiteName);
  rec.metadata.setStandardMetadata(RecordMetadataKey.TOURNAMENT, "B-guru");
  if (input.startedAt) rec.metadata.setStandardMetadata(RecordMetadataKey.START_DATETIME, kifDate(input.startedAt));
  if (input.endedAt) rec.metadata.setStandardMetadata(RecordMetadataKey.END_DATETIME, kifDate(input.endedAt));
  rec.metadata.setStandardMetadata(
    RecordMetadataKey.TIME_LIMIT,
    input.mode === "blitz" ? "10分＋秒読み30秒" : "なし（72時間で放置負け）"
  );
  for (let i = 0; i < input.usis.length; i++) {
    const m = rec.position.createMoveByUSI(input.usis[i]);
    if (!m) throw new Error(`bad move ${input.usis[i]}`);
    rec.append(m);
    rec.current.setElapsedMs(Math.max(0, Math.round(input.spentMs[i] ?? 0)));
  }
  const sp = specialFor(input.endReason, input.result, sideOf(rec.position.color));
  if (sp) rec.append(sp);
  return exportKIF(rec);
}

function specialFor(reason: EndReason | null, result: ShogiResult | null, toMove: Side): SpecialMoveType | null {
  switch (reason) {
    case "resign":
      return SpecialMoveType.RESIGN;
    case "checkmate":
      return SpecialMoveType.MATE;
    case "timeout":
    case "abandon":
      return SpecialMoveType.TIMEOUT;
    case "sennichite":
      return SpecialMoveType.REPETITION_DRAW;
    case "perpetual_check":
      // 反則（連続王手）をした側の負け。手番側が反則した側なら FOUL_LOSE、相手なら FOUL_WIN。
      return result === toMove ? SpecialMoveType.FOUL_WIN : SpecialMoveType.FOUL_LOSE;
    case "aborted":
      return SpecialMoveType.INTERRUPT;
    default:
      return null;
  }
}

function kifDate(d: Date): string {
  // 日本時間で「2026/10/21 21:05:00」
  const j = new Date(d.getTime() + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${j.getUTCFullYear()}/${p(j.getUTCMonth() + 1)}/${p(j.getUTCDate())} ${p(j.getUTCHours())}:${p(j.getUTCMinutes())}:${p(j.getUTCSeconds())}`;
}
