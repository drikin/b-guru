/* ☗ 将棋 — 会員どうしの対局（docs/shogi-spec.md が正）。
 *
 * 正本は DB（shogi_games / shogi_moves）。局面（SFEN）・指し手（USI）・持ち時間はすべて DB にあり、
 * pm2 の再起動・デプロイで対局は止まらない。時計は lib/shogi-clock.ts、ルールは lib/shogi-rules.ts。
 *
 *   状態: open（募集・15 分）／offered（指名・24 時間）─ accept → active ─→ ended
 *         decline / cancel / expire → closed（対局なし）
 *   同時の指し手: expected_ply と client_move_id。1 トランザクションで行をロックし、
 *     UPDATE … WHERE id AND ply AND status='active'。手数が違えば 409 と最新の状態。
 *     同じ client_move_id は二度適用しない（200 と今の状態を返す）。
 *   時間切れ: ①読み取り・指し手のたびにその場で、②プロセス内のタイマー（起動時に張り直す）。
 *   配信: liveBus の { type: "shogi" }（公開の対局）と personalBus（自分への指名）。
 *   節目だけチャットへ（開始のカード 1 件、終局でその本文を書き換え）。終局はビーグルが投稿する。
 *   対局者は users.user_id で持つ（メールは持たない。配信にも載せない）。
 *   ビーグル戦: 相手は system アカウント（SYSTEM_EMAIL、表示名「ビーグル」）。申し込み・受諾なしで
 *     すぐ active。ビーグルの手は lib/shogi-beagle.ts（探索は別スレッド）が playMove で指す。 */
import crypto from "crypto";
import type { PoolClient } from "pg";
import { pool } from "./db";
import { featureEnabledFor, featurePublic } from "./feature-flag";
import { emitLive } from "./live";
import { emitPersonal } from "./personal-live";
import { createPost, gravatarUrl, SYSTEM_EMAIL } from "./posts";
import { ensureUserId } from "./user";
import { resolveDisplayNames } from "./display-name";
import { postShogiCard } from "./chat";
import { pushShogi, syncRead } from "./push-notify";
import {
  INITIAL_SFEN,
  buildKif,
  otherSide,
  sideToMove,
  tryMove,
  type EndReason,
  type ShogiResult,
  type Side,
} from "./shogi-rules";
import {
  BLITZ_BYOYOMI_MS,
  BLITZ_INITIAL_MS,
  deadlineOf,
  dueEvent,
  nextEventAt,
  restartShift,
  spend,
  type ClockState,
  type DueEvent,
  type ShogiMode,
  type ShogiStatus,
} from "./shogi-clock";
import { beagleGamePostText, beaglePostText, cardEndText, cardStartText } from "./shogi-text";
import type { ShogiGameDetailDto, ShogiGameDto, ShogiLiveAction, ShogiMoveDto, ShogiPlayerDto } from "./shogi-types";
import {
  allCommentary,
  commentaryEnabledFor,
  commentaryOn,
  latestCommentary,
  toCommentaryDto,
  turningPointLines,
} from "./shogi-commentary-store";

const BEAGLE_NAME = "ビーグル";
const BASE_URL = (process.env.APP_BASE_URL || "https://bsm.backspace.fm").replace(/\/+$/, "");

/** 一人が同時に出せる募集・指名、同時に指せる対局の上限（いたずら・取り違え防止）。 */
export const MAX_PENDING_PER_USER = 3;
export const MAX_ACTIVE_PER_USER = 5;
/** 一覧に出す終局の数。 */
export const RECENT_ENDED = 20;
/** 観戦の合図はこの間に来ていれば「観戦中」。 */
export const WATCH_TTL_MS = 45_000;

/** SHOGI_ENABLED: 未設定・"0" = 誰にも出さない、"1"（または "*"）= 全員、メールのカンマ区切り = その人だけ
 *  （読み方は lib/feature-flag.ts で MINIGAME_ENABLED と共通）。 */
export function shogiEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor("SHOGI_ENABLED", email);
}

/** 全員に公開しているか（SHOGI_ENABLED が 1）。公開前は、チャットのカード・ビーグルの投稿・通知を出さない
 *  （出している人以外にも見えてしまうため）。 */
export function shogiPublic(): boolean {
  return featurePublic("SHOGI_ENABLED");
}

/** テスト用: SHOGI_SELF_PLAY（メールのカンマ区切り）の人は、自分の募集を自分で受けて両方の手を指せる。 */
export function shogiSelfPlayFor(email: string | null | undefined): boolean {
  if (!email) return false;
  return (process.env.SHOGI_SELF_PLAY ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

/** 自分との対局（テスト用）。 */
export function isSelfGame(r: Pick<GameRow, "black_uid" | "white_uid">): boolean {
  return !!r.black_uid && r.black_uid === r.white_uid;
}

/** 指す側から見た自分の色。自分との対局では手番の側。 */
export function playerSide(r: Pick<GameRow, "black_uid" | "white_uid" | "ply">, userId: string | null | undefined): Side | null {
  if (isSelfGame(r) && r.black_uid === userId) return sideToMove(r.ply);
  return colorOf(r, userId);
}

/** カード・ビーグルの投稿・通知を出してよい対局か。 */
function announces(r: Pick<GameRow, "black_uid" | "white_uid">): boolean {
  return shogiPublic() && !isSelfGame(r);
}

export class ShogiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public game?: ShogiGameDto
  ) {
    super(message);
  }
}

export type Actor = { email: string; userId: string };

// ───────────────────────────────── 行と DTO

export type GameRow = {
  id: number;
  status: ShogiStatus;
  mode: ShogiMode;
  initial_ms: number;
  byoyomi_ms: number;
  creator_uid: string;
  invitee_uid: string | null;
  black_uid: string | null;
  white_uid: string | null;
  rematch_of: number | null;
  sfen: string;
  ply: number;
  last_usi: string | null;
  last_label: string | null;
  clock_b_ms: number;
  clock_w_ms: number;
  turn_started_at: Date | null;
  reminded_at: Date | null;
  result: ShogiResult | null;
  end_reason: ShogiGameDto["end_reason"];
  card_msg_id: number | null;
  result_post_id: number | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  last_activity_at: Date;
  db_now?: Date;
};

const ms = (d: Date | string | null | undefined): number | null => (d == null ? null : new Date(d).getTime());
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());

export function clockOf(r: GameRow): ClockState {
  return {
    status: r.status,
    mode: r.mode,
    ply: r.ply,
    clockBMs: r.clock_b_ms,
    clockWMs: r.clock_w_ms,
    byoyomiMs: r.byoyomi_ms,
    turnStartedAt: ms(r.turn_started_at),
    createdAt: ms(r.created_at) ?? 0,
    invited: !!r.invitee_uid,
    remindedAt: ms(r.reminded_at),
  };
}

export function colorOf(r: Pick<GameRow, "black_uid" | "white_uid">, userId: string | null | undefined): Side | null {
  if (!userId) return null;
  if (r.black_uid === userId) return "black";
  if (r.white_uid === userId) return "white";
  return null;
}

type PlayerInfo = ShogiPlayerDto & { email: string };
const playerCache = new Map<string, { at: number; p: PlayerInfo }>();
const PLAYER_CACHE_MS = 5 * 60_000;

/** user_id → 表示名・アイコン（とサーバ内だけで使うメール）。 */
export async function playersOf(uids: (string | null | undefined)[]): Promise<Map<string, PlayerInfo>> {
  const out = new Map<string, PlayerInfo>();
  const now = Date.now();
  const need: string[] = [];
  for (const u of new Set(uids.filter((x): x is string => !!x))) {
    const hit = playerCache.get(u);
    if (hit && now - hit.at < PLAYER_CACHE_MS) out.set(u, hit.p);
    else need.push(u);
  }
  if (need.length === 0) return out;
  const r = await pool.query(`SELECT user_id, email FROM users WHERE user_id = ANY($1::text[])`, [need]);
  const rows = r.rows as { user_id: string; email: string }[];
  const names = await resolveDisplayNames(rows.map((x) => x.email));
  for (const row of rows) {
    const p: PlayerInfo = {
      user_id: row.user_id,
      name: row.email === SYSTEM_EMAIL ? BEAGLE_NAME : names.get(row.email) || row.email.split("@")[0],
      avatar: gravatarUrl(row.email),
      email: row.email,
    };
    playerCache.set(row.user_id, { at: now, p });
    out.set(row.user_id, p);
  }
  if (playerCache.size > 2000) playerCache.clear();
  return out;
}

const publicPlayer = (p: PlayerInfo | undefined, uid: string | null): ShogiPlayerDto | null =>
  uid ? (p ? { user_id: p.user_id, name: p.name, avatar: p.avatar } : { user_id: uid, name: "（退会した会員）", avatar: null }) : null;

/** 行 → 配信・API の形（メールは載せない）。 */
export function toGameDto(r: GameRow, players: Map<string, PlayerInfo>, nowMs: number): ShogiGameDto {
  const c = clockOf(r);
  const deadline = r.status === "active" ? deadlineOf(c) : r.status === "open" || r.status === "offered" ? nextEventAt(c) : null;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    creator: publicPlayer(players.get(r.creator_uid), r.creator_uid)!,
    invitee: publicPlayer(r.invitee_uid ? players.get(r.invitee_uid) : undefined, r.invitee_uid),
    black: publicPlayer(r.black_uid ? players.get(r.black_uid) : undefined, r.black_uid),
    white: publicPlayer(r.white_uid ? players.get(r.white_uid) : undefined, r.white_uid),
    sfen: r.sfen,
    ply: r.ply,
    turn: sideToMove(r.ply),
    last_move: r.last_usi ? { usi: r.last_usi, label: r.last_label ?? "" } : null,
    clocks:
      r.mode === "blitz"
        ? { black_ms: r.clock_b_ms, white_ms: r.clock_w_ms, byoyomi_ms: r.byoyomi_ms, initial_ms: r.initial_ms }
        : null,
    turn_started_at: r.status === "active" ? iso(r.turn_started_at) : null,
    deadline_at: deadline != null ? new Date(deadline).toISOString() : null,
    server_now: new Date(nowMs).toISOString(),
    spectators: spectatorCount(r.id, nowMs),
    result: r.result,
    end_reason: r.end_reason,
    created_at: iso(r.created_at)!,
    started_at: iso(r.started_at),
    ended_at: iso(r.ended_at),
    rematch_of: r.rematch_of,
    card_message_id: r.card_msg_id,
    result_post_id: r.result_post_id,
  };
}

async function dtoOf(r: GameRow): Promise<ShogiGameDto> {
  const players = await playersOf([r.creator_uid, r.invitee_uid, r.black_uid, r.white_uid]);
  return toGameDto(r, players, ms(r.db_now) ?? Date.now());
}

// ───────────────────────────────── プロセス内の状態（単一プロセス）
// instrumentation と各ルートでモジュールが別々に読まれても 1 つになるよう globalThis に置く。

type ShogiMemory = {
  watchers: Map<number, Map<string, number>>;
  lastSpectatorBroadcast: Map<number, { at: number; n: number }>;
  timers: Map<number, ReturnType<typeof setTimeout>>;
  finalizing: Set<number>;
  ready: Promise<void> | null;
  sweep: ReturnType<typeof setInterval> | null;
  /** ビーグル（system アカウント）の user_id。shogiReady で決まる。 */
  beagleUid: string | null;
};
const g0 = globalThis as unknown as { __bguruShogi?: ShogiMemory };
const mem: ShogiMemory = (g0.__bguruShogi ??= {
  watchers: new Map(),
  lastSpectatorBroadcast: new Map(),
  timers: new Map(),
  finalizing: new Set(),
  ready: null,
  sweep: null,
  beagleUid: null,
});
const watchers = mem.watchers;
const lastSpectatorBroadcast = mem.lastSpectatorBroadcast;

// ───────────────────────────────── 観戦人数

export function spectatorCount(gameId: number, now = Date.now()): number {
  const m = watchers.get(gameId);
  if (!m) return 0;
  let n = 0;
  for (const [u, t] of m) {
    if (now - t <= WATCH_TTL_MS) n++;
    else m.delete(u);
  }
  if (m.size === 0) watchers.delete(gameId);
  return n;
}

/** 観戦中（盤を開いている）の人の user_id（対局者は数えない）。実況の AI を公開前に誰のために呼ぶか決めるのに使う。 */
export function watcherIds(gameId: number, now = Date.now()): string[] {
  spectatorCount(gameId, now); // 古い合図を捨てる
  return [...(watchers.get(gameId)?.keys() ?? [])];
}

export function recordWatch(gameId: number, userId: string, now = Date.now()): number {
  let m = watchers.get(gameId);
  if (!m) {
    m = new Map();
    watchers.set(gameId, m);
  }
  m.set(userId, now);
  return spectatorCount(gameId, now);
}

// ───────────────────────────────── 配信・通知

/** 状態の配信。募集・対局・終局は全員へ、指名まわり（offered／指名の取り下げ・断り・期限切れ）は二人にだけ。 */
export async function broadcast(r: GameRow, action: Exclude<ShogiLiveAction, "offer">): Promise<ShogiGameDto> {
  const game = await dtoOf(r);
  const privateGame = r.status === "offered" || (r.status === "closed" && !!r.invitee_uid);
  if (privateGame) {
    const players = await playersOf([r.creator_uid, r.invitee_uid]);
    for (const uid of [r.creator_uid, r.invitee_uid]) {
      const p = uid ? players.get(uid) : undefined;
      if (p) emitPersonal(p.email, { type: "shogi", action: "state", game });
    }
  } else {
    emitLive({ type: "shogi", action, game });
  }
  return game;
}

async function emailOf(uid: string | null): Promise<string | null> {
  if (!uid) return null;
  return (await playersOf([uid])).get(uid)?.email ?? null;
}

function logErr(where: string) {
  return (e: unknown) => console.error(`[shogi] ${where}:`, (e as Error)?.message);
}

// ───────────────────────────────── 読み取り

const SELECT_GAME = `SELECT g.*, now() AS db_now FROM shogi_games g`;

async function lockGame(c: PoolClient, id: number): Promise<GameRow | null> {
  const r = await c.query(`${SELECT_GAME} WHERE g.id = $1 FOR UPDATE`, [id]);
  return (r.rows[0] as GameRow) ?? null;
}

async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** 期限が来ていればその場で片付けてから返す（読み取りのたびの時間切れ判定）。 */
async function settled(r: GameRow): Promise<GameRow> {
  const now = ms(r.db_now) ?? Date.now();
  if (dueEvent(clockOf(r), now)) {
    const after = await resolveDue(r.id);
    if (after) return after;
  }
  return r;
}

export async function listGames(actor: Actor, statuses: ShogiStatus[]): Promise<ShogiGameDto[]> {
  await shogiReady();
  const want = new Set(statuses.length ? statuses : (["open", "offered", "active", "ended"] as ShogiStatus[]));
  const rows: GameRow[] = [];
  const live = (
    await pool.query(
      `${SELECT_GAME} WHERE g.status IN ('open', 'offered', 'active') ORDER BY g.id DESC LIMIT 200`
    )
  ).rows as GameRow[];
  for (const r0 of live) {
    const r = await settled(r0);
    if (!want.has(r.status)) continue;
    // 指名は二人にだけ見える。
    if (r.status === "offered" && r.creator_uid !== actor.userId && r.invitee_uid !== actor.userId) continue;
    rows.push(r);
  }
  if (want.has("ended")) {
    const ended = (
      await pool.query(`${SELECT_GAME} WHERE g.status = 'ended' ORDER BY g.ended_at DESC NULLS LAST LIMIT $1`, [RECENT_ENDED])
    ).rows as GameRow[];
    for (const r of ended) if (!rows.some((x) => x.id === r.id)) rows.push(r);
  }
  const players = await playersOf(rows.flatMap((r) => [r.creator_uid, r.invitee_uid, r.black_uid, r.white_uid]));
  const now = Date.now();
  return rows.map((r) => toGameDto(r, players, ms(r.db_now) ?? now));
}

export async function loadGame(id: number): Promise<GameRow | null> {
  const r = await pool.query(`${SELECT_GAME} WHERE g.id = $1`, [id]);
  return (r.rows[0] as GameRow) ?? null;
}

function visibleTo(r: GameRow, actor: Actor): boolean {
  if (r.status === "offered" || (r.status === "closed" && r.invitee_uid)) {
    return r.creator_uid === actor.userId || r.invitee_uid === actor.userId;
  }
  return true;
}

export async function getGameDetail(actor: Actor, id: number): Promise<ShogiGameDetailDto> {
  await shogiReady();
  const r0 = await loadGame(id);
  if (!r0 || !visibleTo(r0, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
  const r = await settled(r0);
  const mv = await pool.query(
    `SELECT ply, usi, label, sfen_after, spent_ms, created_at FROM shogi_moves WHERE game_id = $1 ORDER BY ply`,
    [id]
  );
  const moves: ShogiMoveDto[] = mv.rows.map((m) => ({
    ply: m.ply,
    usi: m.usi,
    label: m.label,
    sfen: m.sfen_after,
    spent_ms: m.spent_ms,
    at: new Date(m.created_at).toISOString(),
  }));
  const game = await dtoOf(r);
  const out: ShogiGameDetailDto = { ...game, moves, kif_url: `/api/shogi/games/${id}/kif`, my_color: playerSide(r, actor.userId) };
  // ビーグルの実況（SHOGI_COMMENTARY_ENABLED の人だけ）: 途中から開いた・読み直した人にも最新の 1 行。終局後は手ごとの全部。
  if (commentaryEnabledFor(actor.email)) {
    try {
      const latest = await latestCommentary(id);
      out.commentary = latest ? toCommentaryDto(latest) : null;
      if (r.status === "ended") out.commentaries = (await allCommentary(id)).map(toCommentaryDto);
    } catch (e) {
      logErr("commentary read")(e);
    }
  }
  return out;
}

export async function gameKif(actor: Actor, id: number): Promise<{ filename: string; text: string }> {
  await shogiReady();
  const r = await loadGame(id);
  if (!r || !visibleTo(r, actor) || !r.black_uid || !r.white_uid) throw new ShogiError(404, "not_found", "棋譜がありません");
  const mv = await pool.query(`SELECT usi, spent_ms FROM shogi_moves WHERE game_id = $1 ORDER BY ply`, [id]);
  const players = await playersOf([r.black_uid, r.white_uid]);
  const text = buildKif({
    usis: mv.rows.map((m) => m.usi),
    spentMs: mv.rows.map((m) => m.spent_ms),
    blackName: players.get(r.black_uid)?.name ?? "先手",
    whiteName: players.get(r.white_uid)?.name ?? "後手",
    startedAt: r.started_at,
    endedAt: r.status === "ended" ? r.ended_at : null,
    mode: r.mode,
    result: r.result,
    endReason: r.status === "ended" ? (r.end_reason as EndReason | null) : null,
  });
  return { filename: `bguru-shogi-${id}.kif`, text };
}

// ───────────────────────────────── 申し込む・受ける・断る・取り下げる

export async function createGame(
  actor: Actor,
  input: { mode: unknown; invitee_user_id?: unknown; rematch_of?: unknown; opponent?: unknown }
): Promise<ShogiGameDto> {
  await shogiReady();
  const mode = input.mode === "blitz" || input.mode === "slow" ? input.mode : null;
  if (!mode) throw new ShogiError(400, "invalid_request", "mode は blitz か slow です");
  if (input.opponent != null && input.opponent !== "beagle") throw new ShogiError(400, "invalid_request", "opponent は beagle だけです");
  if (input.opponent === "beagle") return createBeagleGame(actor, mode, input.rematch_of);
  // ビーグル戦の再戦（opponent を付けずに rematch_of だけ来た）もビーグル戦にする。
  if (input.rematch_of != null && mem.beagleUid) {
    const prev = await loadGame(Number(input.rematch_of)).catch(() => null);
    if (prev && isBeagleGame(prev) && colorOf(prev, actor.userId)) return createBeagleGame(actor, mode, input.rematch_of);
  }
  let invitee = typeof input.invitee_user_id === "string" && input.invitee_user_id ? input.invitee_user_id : null;
  let rematchOf: number | null = null;
  if (input.rematch_of != null) {
    const id = Number(input.rematch_of);
    if (!Number.isInteger(id) || id <= 0) throw new ShogiError(400, "invalid_request", "rematch_of が不正です");
    const prev = await loadGame(id);
    const mine = prev ? colorOf(prev, actor.userId) : null;
    if (!prev || prev.status !== "ended" || !mine) throw new ShogiError(400, "invalid_request", "再戦できる対局ではありません");
    invitee = mine === "black" ? prev.white_uid : prev.black_uid;
    rematchOf = id;
  }
  if (invitee) {
    if (invitee === actor.userId) throw new ShogiError(400, "invalid_request", "自分は指名できません");
    const email = await emailOf(invitee);
    if (!email || email === SYSTEM_EMAIL) throw new ShogiError(400, "invalid_request", "指名できる会員が見つかりません");
  }
  // 対局はサイト全体で 1 つだけ（ドリキン 2026-10-21「セッションは常に 1 個だけで早い者勝ち」）。
  // 期限が過ぎた募集・終わっている対局は先に片付けてから数える。
  const live = await pool.query(`SELECT id FROM shogi_games WHERE status IN ('open', 'offered', 'active')`);
  for (const r of live.rows as { id: number }[]) await resolveDue(r.id).catch(logErr("resolve before create"));
  const created = await tx(async (c) => {
    // 同時に 2 人が募集しても 1 つだけ作る（この取引の間だけの鍵）。
    await c.query(`SELECT pg_advisory_xact_lock(4747001)`);
    await assertNotBusy(c, actor);
    const initial = mode === "blitz" ? BLITZ_INITIAL_MS : 0;
    const byo = mode === "blitz" ? BLITZ_BYOYOMI_MS : 0;
    const ins = await c.query(
      `INSERT INTO shogi_games (status, mode, initial_ms, byoyomi_ms, creator_uid, invitee_uid, rematch_of, sfen, clock_b_ms, clock_w_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $3, $3)
       RETURNING *, now() AS db_now`,
      [invitee ? "offered" : "open", mode, initial, byo, actor.userId, invitee, rematchOf, INITIAL_SFEN]
    );
    return ins.rows[0] as GameRow;
  });
  const row = created;
  schedule(row);
  const game = await broadcast(row, "state");
  if (invitee) {
    const email = await emailOf(invitee);
    if (email && shogiEnabledFor(email)) {
      emitPersonal(email, { type: "shogi", action: "offer", game });
      void pushShogi(email, "shogi_offer", row.id).catch(logErr("push offer"));
    }
  }
  return game;
}

// ───────────────────────────────── ビーグル戦

/** ビーグル（system アカウント）の user_id。決まっていなければ null。 */
export function beagleUid(): string | null {
  return mem.beagleUid;
}

export function isBeagleGame(r: Pick<GameRow, "black_uid" | "white_uid">): boolean {
  return !!mem.beagleUid && (r.black_uid === mem.beagleUid || r.white_uid === mem.beagleUid);
}

/** ビーグルの色（ビーグル戦でなければ null）。 */
export function beagleSide(r: Pick<GameRow, "black_uid" | "white_uid">): Side | null {
  if (!mem.beagleUid) return null;
  if (r.black_uid === mem.beagleUid) return "black";
  if (r.white_uid === mem.beagleUid) return "white";
  return null;
}

export function beagleActor(): Actor | null {
  return mem.beagleUid ? { email: SYSTEM_EMAIL, userId: mem.beagleUid } : null;
}

/** 進行中の対局があれば 409 busy（対局はサイト全体で 1 つだけ）。取引の中で、鍵を取ってから呼ぶ。 */
async function assertNotBusy(c: PoolClient, actor: Actor): Promise<void> {
  const busy = await c.query(
    `SELECT *, now() AS db_now FROM shogi_games WHERE status IN ('open', 'offered', 'active') ORDER BY id LIMIT 1`
  );
  if (!busy.rows[0]) return;
  const b = busy.rows[0] as GameRow;
  // 指名の申し込みは当事者にしか見せない（中身は返さない）。
  if (b.status === "offered" && !visibleTo(b, actor)) {
    throw new ShogiError(409, "busy", "いまは対局の申し込みが出ています（少し待ってください）");
  }
  const msg = b.status === "active" ? "いまは対局中です（観戦してください）" : "募集中の対局があります（受けてください）";
  throw new ShogiError(409, "busy", msg, await dtoOf(b));
}

/** ビーグルと対局（練習）: 申し込み・受諾なしですぐ始まる。先後は振り駒（ビーグル戦の再戦は入れ替え）。 */
async function createBeagleGame(actor: Actor, mode: ShogiMode, rematchRaw: unknown): Promise<ShogiGameDto> {
  const bot = mem.beagleUid;
  if (!bot) throw new ShogiError(409, "unavailable", "いまはビーグルと対局できません");
  if (actor.userId === bot) throw new ShogiError(400, "invalid_request", "ビーグルは自分とは指せません");
  let rematchOf: number | null = null;
  let swapFrom: GameRow | null = null;
  if (rematchRaw != null) {
    const id = Number(rematchRaw);
    if (!Number.isInteger(id) || id <= 0) throw new ShogiError(400, "invalid_request", "rematch_of が不正です");
    const prev = await loadGame(id);
    if (!prev || prev.status !== "ended" || !colorOf(prev, actor.userId) || !isBeagleGame(prev)) {
      throw new ShogiError(400, "invalid_request", "再戦できる対局ではありません");
    }
    rematchOf = id;
    swapFrom = prev;
  }
  const live = await pool.query(`SELECT id FROM shogi_games WHERE status IN ('open', 'offered', 'active')`);
  for (const r of live.rows as { id: number }[]) await resolveDue(r.id).catch(logErr("resolve before create"));
  const row = await tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(4747001)`);
    await assertNotBusy(c, actor);
    let humanBlack: boolean;
    if (swapFrom) humanBlack = swapFrom.black_uid !== actor.userId;
    else humanBlack = crypto.randomInt(2) === 0;
    const black = humanBlack ? actor.userId : bot;
    const white = humanBlack ? bot : actor.userId;
    const initial = mode === "blitz" ? BLITZ_INITIAL_MS : 0;
    const byo = mode === "blitz" ? BLITZ_BYOYOMI_MS : 0;
    const ins = await c.query(
      `INSERT INTO shogi_games (status, mode, initial_ms, byoyomi_ms, creator_uid, invitee_uid, black_uid, white_uid, rematch_of, sfen,
                                clock_b_ms, clock_w_ms, started_at, turn_started_at, last_activity_at)
       VALUES ('active', $1, $2, $3, $4, $5, $6, $7, $8, $9, $2, $2, now(), now(), now())
       RETURNING *, now() AS db_now`,
      [mode, initial, byo, actor.userId, bot, black, white, rematchOf, INITIAL_SFEN]
    );
    return ins.rows[0] as GameRow;
  });
  await postStartCard(row);
  schedule(row);
  const game = await broadcast(row, "state");
  kickBeagle(row);
  return game;
}

/** ビーグルの実況を頼む（指し手の確定・配信のあと。別の流れで、呼び出し側は待たない。lib/shogi-commentary.ts）。 */
function kickCommentary(kind: "move" | "end", r: GameRow): void {
  if (!commentaryOn()) return;
  void import("./shogi-commentary")
    .then((m) => (kind === "move" ? m.queueMoveCommentary(r.id, r.ply) : m.queueEndCommentary(r)))
    .catch(logErr("commentary"));
}

/** 手番がビーグルなら、ビーグルに考えさせる（別の流れで。呼び出し側は待たない）。 */
export function kickBeagle(r: Pick<GameRow, "id" | "status" | "ply" | "black_uid" | "white_uid">): void {
  if (r.status !== "active") return;
  const side = beagleSide(r);
  if (!side || sideToMove(r.ply) !== side) return;
  const p: Promise<void> = import("./shogi-beagle")
    .then((m) => m.beagleTurn(r.id))
    .catch(logErr("beagle"))
    .finally(() => beagleKicks.delete(p));
  beagleKicks.add(p);
}

const beagleKicks = new Set<Promise<void>>();

/** テスト用: ビーグルが考え中・指し途中の手がすべて終わるまで待つ。 */
export async function _beagleSettledForTest(): Promise<void> {
  while (beagleKicks.size > 0) await Promise.allSettled([...beagleKicks]);
}

/** 節目: チャットに対局中カードを 1 件（公開後・自分との対局でないときだけ）。 */
async function postStartCard(out: GameRow): Promise<void> {
  if (!announces(out)) return;
  try {
    const players = await playersOf([out.black_uid, out.white_uid]);
    const names = { black: players.get(out.black_uid!)?.name ?? "先手", white: players.get(out.white_uid!)?.name ?? "後手" };
    const card = await postShogiCard(cardStartText(names, out.mode), out.id);
    if (card) {
      await pool.query(`UPDATE shogi_games SET card_msg_id = $2 WHERE id = $1`, [out.id, card.id]);
      out.card_msg_id = card.id;
    }
  } catch (e) {
    logErr("card")(e);
  }
}

export async function acceptGame(actor: Actor, id: number): Promise<ShogiGameDto> {
  await shogiReady();
  const out = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
    if (r.status !== "open" && r.status !== "offered") throw new ShogiError(409, "not_open", "もう受けられません");
    const now = ms(r.db_now)!;
    if (dueEvent(clockOf(r), now)?.kind === "expire") throw new ShogiError(409, "expired", "申し込みの期限が切れました");
    const self = r.creator_uid === actor.userId;
    if (self && !shogiSelfPlayFor(actor.email)) throw new ShogiError(400, "invalid_request", "自分の申し込みは受けられません");
    if (r.status === "offered" && r.invitee_uid !== actor.userId) throw new ShogiError(403, "forbidden", "指名された人だけが受けられます");
    const act = await c.query(
      `SELECT count(*)::int AS n FROM shogi_games WHERE status = 'active' AND (black_uid = $1 OR white_uid = $1)`,
      [actor.userId]
    );
    if (act.rows[0].n >= MAX_ACTIVE_PER_USER) throw new ShogiError(409, "too_many", `同時に指せる対局は ${MAX_ACTIVE_PER_USER} 局までです`);
    // 先後: いつも振り駒。再戦は前の対局の先後を入れ替える。
    let black: string;
    let white: string;
    const prev = r.rematch_of ? (await c.query(`SELECT black_uid, white_uid FROM shogi_games WHERE id = $1`, [r.rematch_of])).rows[0] : null;
    if (prev && [prev.black_uid, prev.white_uid].includes(r.creator_uid) && [prev.black_uid, prev.white_uid].includes(actor.userId)) {
      black = prev.white_uid;
      white = prev.black_uid;
    } else if (self) {
      black = white = actor.userId; // 自分との対局（テスト用）
    } else if (crypto.randomInt(2) === 0) {
      black = r.creator_uid;
      white = actor.userId;
    } else {
      black = actor.userId;
      white = r.creator_uid;
    }
    const up = await c.query(
      `UPDATE shogi_games SET status = 'active', invitee_uid = COALESCE(invitee_uid, $2), black_uid = $3, white_uid = $4,
              started_at = now(), turn_started_at = now(), last_activity_at = now()
        WHERE id = $1 AND status IN ('open', 'offered')
        RETURNING *, now() AS db_now`,
      [id, actor.userId, black, white]
    );
    if (!up.rows[0]) throw new ShogiError(409, "not_open", "もう受けられません");
    return up.rows[0] as GameRow;
  });
  await postStartCard(out);
  schedule(out);
  void syncRead(actor.email, { scope: "shogi", game_id: out.id }).catch(logErr("sync accept")); // 受けた: 申し込みの知らせは古い
  const game = await broadcast(out, "state");
  if (announces(out) && out.mode === "slow" && out.black_uid !== actor.userId) {
    const email = await emailOf(out.black_uid);
    if (email) void pushShogi(email, "shogi_turn", out.id).catch(logErr("push turn"));
  }
  return game;
}

export async function declineGame(actor: Actor, id: number): Promise<ShogiGameDto> {
  await shogiReady();
  const out = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
    if (r.status !== "offered" || r.invitee_uid !== actor.userId) throw new ShogiError(409, "not_offered", "断れる申し込みではありません");
    const up = await c.query(
      `UPDATE shogi_games SET status = 'closed', end_reason = 'declined', ended_at = now(), last_activity_at = now()
        WHERE id = $1 RETURNING *, now() AS db_now`,
      [id]
    );
    return up.rows[0] as GameRow;
  });
  unschedule(out.id);
  void syncRead(actor.email, { scope: "shogi", game_id: out.id }).catch(logErr("sync decline"));
  return broadcast(out, "state");
}

/** 取り下げる: 募集・指名は出した人が。対局は 2 手目までなら対局者のどちらでも（中断・勝敗なし）。 */
export async function cancelGame(actor: Actor, id: number): Promise<ShogiGameDto> {
  await shogiReady();
  const out = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
    if (r.status === "open" || r.status === "offered") {
      if (r.creator_uid !== actor.userId) throw new ShogiError(403, "forbidden", "出した人だけが取り下げられます");
      const up = await c.query(
        `UPDATE shogi_games SET status = 'closed', end_reason = 'cancelled', ended_at = now(), last_activity_at = now()
          WHERE id = $1 RETURNING *, now() AS db_now`,
        [id]
      );
      return { row: up.rows[0] as GameRow, ended: false };
    }
    if (r.status === "active") {
      if (!colorOf(r, actor.userId)) throw new ShogiError(403, "forbidden", "対局者ではありません");
      if (r.ply >= 2) throw new ShogiError(409, "too_late", "2 手目のあとは取り消せません（投了してください）");
      const row = await endInTx(c, r, null, "aborted");
      return { row, ended: true };
    }
    throw new ShogiError(409, "not_cancellable", "取り下げられる状態ではありません");
  });
  unschedule(out.row.id);
  if (out.ended) return finalize(out.row);
  return broadcast(out.row, "state");
}

// ───────────────────────────────── 指す・投了

export type MoveInput = { usi: unknown; expected_ply: unknown; client_move_id?: unknown };
const CLIENT_MOVE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 指す。戻り値の duplicate = 同じ client_move_id の再送（何もしていない）。 */
export async function playMove(actor: Actor, id: number, input: MoveInput): Promise<{ game: ShogiGameDto; duplicate: boolean }> {
  await shogiReady();
  const usi = typeof input.usi === "string" ? input.usi.trim() : "";
  const expected = Number(input.expected_ply);
  if (!Number.isInteger(expected) || expected < 0) throw new ShogiError(400, "invalid_request", "expected_ply が必要です");
  const clientMoveId =
    typeof input.client_move_id === "string" && CLIENT_MOVE_ID_RE.test(input.client_move_id) ? input.client_move_id : null;
  if (input.client_move_id != null && !clientMoveId) throw new ShogiError(400, "invalid_request", "client_move_id が不正です");

  type Out = { kind: "dup"; row: GameRow } | { kind: "moved"; row: GameRow } | { kind: "ended"; row: GameRow };
  let lost: GameRow | null = null;
  const out: Out = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
    if (clientMoveId) {
      const dup = await c.query(`SELECT 1 FROM shogi_moves WHERE game_id = $1 AND client_move_id = $2`, [id, clientMoveId]);
      if (dup.rows.length > 0) return { kind: "dup", row: r };
    }
    const mine = playerSide(r, actor.userId);
    if (!mine) throw new ShogiError(403, "forbidden", "対局者ではありません");
    if (r.status !== "active") throw new ShogiError(409, "not_active", "対局は終わっています", await dtoOf(r));
    if (expected !== r.ply) throw new ShogiError(409, "conflict", "局面が進んでいます（最新の状態を読み直してください）", await dtoOf(r));
    if (sideToMove(r.ply) !== mine) throw new ShogiError(409, "not_your_turn", "相手の番です", await dtoOf(r));
    const now = ms(r.db_now)!;
    const sp = spend(clockOf(r), now);
    if (!sp.ok) {
      // もう時間切れ（または 1 手目前の中断）: 指し手は採らずにその場で終局させる。
      const row = await endInTx(c, r, sp.reason === "timeout" ? otherSide(mine) : null, sp.reason === "timeout" ? "timeout" : "aborted");
      lost = row;
      return { kind: "ended", row };
    }
    const hist = await c.query(`SELECT usi FROM shogi_moves WHERE game_id = $1 ORDER BY ply`, [id]);
    const tried = tryMove(hist.rows.map((m) => m.usi as string), usi);
    if (!tried.ok) {
      throw new ShogiError(400, tried.error === "bad_usi" ? "invalid_request" : "illegal_move", "その手は指せません");
    }
    await c.query(
      `INSERT INTO shogi_moves (game_id, ply, usi, label, sfen_after, spent_ms, client_move_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, r.ply + 1, tried.usi, tried.label, tried.sfen, Math.min(sp.spentMs, 2_000_000_000), clientMoveId]
    );
    const end = tried.end;
    const up = await c.query(
      `UPDATE shogi_games SET sfen = $3, ply = ply + 1, last_usi = $4, last_label = $5, clock_b_ms = $6, clock_w_ms = $7,
              turn_started_at = now(), reminded_at = NULL, last_activity_at = now(),
              status = CASE WHEN $8::text IS NULL THEN status ELSE 'ended' END,
              result = $8::text, end_reason = $9::text,
              ended_at = CASE WHEN $8::text IS NULL THEN NULL ELSE now() END
        WHERE id = $1 AND ply = $2 AND status = 'active'
        RETURNING *, now() AS db_now`,
      [id, r.ply, tried.sfen, tried.usi, tried.label, sp.clockBMs, sp.clockWMs, end?.result ?? null, end?.reason ?? null]
    );
    if (!up.rows[0]) throw new ShogiError(409, "conflict", "局面が進んでいます（最新の状態を読み直してください）", await dtoOf(r));
    const row = up.rows[0] as GameRow;
    return { kind: end ? "ended" : "moved", row };
  });

  if (out.kind === "dup") return { game: await dtoOf(out.row), duplicate: true };
  if (out.kind === "ended") {
    unschedule(out.row.id);
    const game = await finalize(out.row);
    if (lost) throw new ShogiError(409, "game_over", "時間切れです", game);
    kickCommentary("move", out.row); // 詰み・千日手で終わった手の実況
    return { game, duplicate: false };
  }
  schedule(out.row);
  void syncRead(actor.email, { scope: "shogi", game_id: out.row.id }).catch(logErr("sync move")); // 指した: 「あなたの番です」は古い
  const game = await broadcast(out.row, "state");
  kickCommentary("move", out.row);
  const next = sideToMove(out.row.ply) === "black" ? out.row.black_uid : out.row.white_uid;
  if (out.row.mode === "slow" && !isSelfGame(out.row) && next !== mem.beagleUid) {
    const email = await emailOf(next);
    if (email) void pushShogi(email, "shogi_turn", out.row.id).catch(logErr("push turn"));
  }
  kickBeagle(out.row);
  return { game, duplicate: false };
}

export async function resignGame(actor: Actor, id: number): Promise<ShogiGameDto> {
  await shogiReady();
  const row = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
    const mine = playerSide(r, actor.userId);
    if (!mine) throw new ShogiError(403, "forbidden", "対局者ではありません");
    if (r.status !== "active") throw new ShogiError(409, "not_active", "対局は終わっています", await dtoOf(r));
    // 先に時間切れになっていれば、そちらが正しい終わり方。
    const due = dueEvent(clockOf(r), ms(r.db_now)!);
    if (due && due.kind !== "remind") return applyDueInTx(c, r, due);
    return endInTx(c, r, otherSide(mine), "resign");
  });
  unschedule(row.id);
  if (row.status === "ended") return finalize(row);
  return broadcast(row, "state");
}

export async function watchGame(actor: Actor, id: number): Promise<{ spectators: number }> {
  const r = await loadGame(id);
  if (!r || !visibleTo(r, actor)) throw new ShogiError(404, "not_found", "対局が見つかりません");
  if (r.status !== "active") return { spectators: spectatorCount(id) };
  // 対局者は観戦人数に数えない。
  if (colorOf(r, actor.userId)) return { spectators: spectatorCount(id) };
  const n = recordWatch(id, actor.userId);
  const prev = lastSpectatorBroadcast.get(id);
  const now = Date.now();
  if (!prev || (prev.n !== n && now - prev.at > 10_000)) {
    lastSpectatorBroadcast.set(id, { at: now, n });
    void broadcast(r, "state").catch(logErr("spectators"));
  }
  return { spectators: n };
}

// ───────────────────────────────── 終局

/** トランザクションの中で終局にする（勝ち = result、中断なら null）。 */
async function endInTx(c: PoolClient, r: GameRow, result: ShogiResult | null, reason: EndReason): Promise<GameRow> {
  const up = await c.query(
    `UPDATE shogi_games SET status = 'ended', result = $2, end_reason = $3, ended_at = now(), last_activity_at = now()
      WHERE id = $1 AND status = 'active' RETURNING *, now() AS db_now`,
    [r.id, result, reason]
  );
  if (!up.rows[0]) throw new ShogiError(409, "not_active", "対局は終わっています");
  return up.rows[0] as GameRow;
}

const finalizing = mem.finalizing;

/** 終局のあと（コミット後に 1 度だけ）: カードの書き換え、ビーグルの投稿、配信。 */
async function finalize(row: GameRow): Promise<ShogiGameDto> {
  if (finalizing.has(row.id)) return dtoOf(row);
  finalizing.add(row.id);
  try {
    watchers.delete(row.id);
    lastSpectatorBroadcast.delete(row.id);
    // 終わった対局の「あなたの番です」は、どちらの端末に残っていても古い（read_sync）。
    for (const uid of [row.black_uid, row.white_uid]) {
      if (!uid || uid === mem.beagleUid) continue;
      void emailOf(uid).then((e) => (e ? syncRead(e, { scope: "shogi", game_id: row.id }) : 0)).catch(logErr("sync end"));
    }
    const players = await playersOf([row.black_uid, row.white_uid]);
    const names = { black: players.get(row.black_uid ?? "")?.name ?? "先手", white: players.get(row.white_uid ?? "")?.name ?? "後手" };
    const reason = row.end_reason as EndReason | null;
    if (row.card_msg_id) {
      await postShogiCard(cardEndText(names, row.mode, row.result, reason, row.ply), row.id, row.card_msg_id).catch(logErr("card end"));
    }
    const bSide = beagleSide(row);
    // 実況の「分かれ目」（実況を全員に公開した後だけ。評価が大きく動いた 3 手まで）。
    const turningPoints = announces(row) && !row.result_post_id ? await turningPointLines(row.id, names).catch(() => []) : [];
    const postInput = { gameId: row.id, names, mode: row.mode, result: row.result, reason, ply: row.ply, baseUrl: BASE_URL, turningPoints };
    const text = !announces(row) ? null : bSide ? beagleGamePostText({ ...postInput, beagle: bSide }) : beaglePostText(postInput);
    if (text && !row.result_post_id) {
      try {
        const p = await createPost({ authorEmail: SYSTEM_EMAIL, authorName: BEAGLE_NAME, text, noPreview: true });
        await pool.query(`UPDATE shogi_games SET result_post_id = $2 WHERE id = $1`, [row.id, p.id]);
        row.result_post_id = p.id;
        emitLive({ type: "post", postId: p.id, action: "create", authorId: p.authorId });
      } catch (e) {
        logErr("beagle post")(e);
      }
    }
    kickCommentary("end", row);
    return await broadcast(row, "end");
  } finally {
    finalizing.delete(row.id);
  }
}

// ───────────────────────────────── 期限（その場の判定とタイマー）

async function applyDueInTx(c: PoolClient, r: GameRow, due: DueEvent): Promise<GameRow> {
  switch (due.kind) {
    case "expire": {
      const up = await c.query(
        `UPDATE shogi_games SET status = 'closed', end_reason = 'expired', ended_at = now(), last_activity_at = now()
          WHERE id = $1 AND status IN ('open', 'offered') RETURNING *, now() AS db_now`,
        [r.id]
      );
      return (up.rows[0] as GameRow) ?? r;
    }
    case "abort":
      return endInTx(c, r, null, "aborted");
    case "timeout":
      return endInTx(c, r, otherSide(due.loser), "timeout");
    case "abandon":
      return endInTx(c, r, otherSide(due.loser), "abandon");
    case "remind": {
      const up = await c.query(
        `UPDATE shogi_games SET reminded_at = now() WHERE id = $1 AND reminded_at IS NULL RETURNING *, now() AS db_now`,
        [r.id]
      );
      return (up.rows[0] as GameRow) ?? r;
    }
  }
}

/** 期限が来た対局を片付ける（行をロックして DB の now() で判定し直す）。片付けたあとの行を返す。 */
export async function resolveDue(id: number): Promise<GameRow | null> {
  let due: DueEvent | null = null;
  let before: GameRow | null = null;
  const row = await tx(async (c) => {
    const r = await lockGame(c, id);
    if (!r) return null;
    before = r;
    due = dueEvent(clockOf(r), ms(r.db_now)!);
    if (!due) return r;
    return applyDueInTx(c, r, due);
  });
  if (!row) return null;
  const d = due as DueEvent | null;
  if (!d) {
    schedule(row);
    return row;
  }
  if (d.kind === "remind") {
    schedule(row);
    if ((before as GameRow | null)?.reminded_at == null && row.reminded_at && !isSelfGame(row)) {
      const uid = d.side === "black" ? row.black_uid : row.white_uid;
      const email = uid === mem.beagleUid ? null : await emailOf(uid);
      if (email) void pushShogi(email, "shogi_turn", row.id).catch(logErr("push remind"));
    }
    return row;
  }
  unschedule(row.id);
  if (row.status === "ended") await finalize(row);
  else await broadcast(row, "state");
  return row;
}

const timers = mem.timers;
const MAX_DELAY = 2_147_000_000;

export function schedule(r: GameRow): void {
  unschedule(r.id);
  const at = nextEventAt(clockOf(r));
  if (at == null) return;
  // DB と Node の時計のずれは小さい（同じ機械）。張るのは目安で、判定は resolveDue が DB の now() でやり直す。
  const delay = Math.min(MAX_DELAY, Math.max(0, at - Date.now() + 50));
  const t = setTimeout(() => {
    timers.delete(r.id);
    void resolveDue(r.id).catch(logErr("timer"));
  }, delay);
  t.unref?.();
  timers.set(r.id, t);
}

export function unschedule(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

/** このプロセスが起動した時刻（Node の時計。DB と同じ機械）。 */
const BOOT_AT = Date.now() - Math.round(process.uptime() * 1000);

/** 起動時に 1 度: 止まっていた間の時間切れを延ばし（restartShift）、進行中の対局のタイマーを張り直す。
 *  API はこれが終わってから時間切れを判定する。 */
export function shogiReady(): Promise<void> {
  if (!mem.ready) {
    mem.ready = (async () => {
      // ビーグル（system アカウント）の user_id。失敗してもほかの将棋は動かす（ビーグル戦だけ出せない）。
      if (!mem.beagleUid) mem.beagleUid = await ensureUserId(SYSTEM_EMAIL).catch((e) => (logErr("beagle uid")(e), null));
      const r = await pool.query(`${SELECT_GAME} WHERE g.status IN ('open', 'offered', 'active')`);
      const kick: GameRow[] = [];
      for (const row of r.rows as GameRow[]) {
        const shifted = restartShift(clockOf(row), BOOT_AT);
        if (shifted != null && row.turn_started_at) {
          // 差分で動かす（JS の Date はマイクロ秒を落とすので、値の一致では比べない）。
          const up = await pool.query(
            `UPDATE shogi_games SET turn_started_at = turn_started_at + make_interval(secs => $2::double precision / 1000)
              WHERE id = $1 AND status = 'active' RETURNING *, now() AS db_now`,
            [row.id, shifted - ms(row.turn_started_at)!]
          );
          if (up.rows[0]) {
            schedule(up.rows[0] as GameRow);
            kick.push(up.rows[0] as GameRow);
            continue;
          }
        }
        schedule(row);
        kick.push(row);
      }
      // 再起動の前にビーグルの番だった対局: 考え直して指す（準備が終わってから）。
      setTimeout(() => kick.forEach(kickBeagle), 0).unref?.();
    })().catch((e) => {
      mem.ready = null; // DB が起動前などで失敗したら次の呼び出しでやり直す
      throw e;
    });
  }
  return mem.ready;
}

/** プロセスに 1 つ: 起動時の張り直しと、1 分ごとの見回り（タイマーの取りこぼし対策）。 */
export function ensureShogiSweeper(): void {
  if (mem.sweep) return;
  void shogiReady().catch(logErr("ready"));
  mem.sweep = setInterval(async () => {
    try {
      await shogiReady();
      const r = await pool.query(`${SELECT_GAME} WHERE g.status IN ('open', 'offered', 'active')`);
      for (const row of r.rows as GameRow[]) {
        if (dueEvent(clockOf(row), ms(row.db_now)!)) await resolveDue(row.id);
        else {
          if (!timers.has(row.id)) schedule(row);
          kickBeagle(row); // ビーグルの番のまま止まっていないか（考え中なら何もしない）
        }
      }
    } catch (e) {
      logErr("sweeper")(e);
    }
  }, 60_000);
  mem.sweep.unref?.();
}

/** テスト用: メモリの状態を消す。 */
export function _resetShogiForTest(): void {
  for (const id of [...timers.keys()]) unschedule(id);
  watchers.clear();
  lastSpectatorBroadcast.clear();
  playerCache.clear();
  finalizing.clear();
  mem.ready = null;
  mem.beagleUid = null;
  if (mem.sweep) clearInterval(mem.sweep);
  mem.sweep = null;
}
