/* 🎮 締め切りダッシュ — 1 人で遊ぶミニゲームのハイスコア競争（docs/minigame-spec.md が正）。
 *
 *   1 回ごとに番号と種を発行（POST plays、1 回限り・30 分で期限切れ）→ 端末で遊ぶ → 操作の記録を送る（finish）
 *   → サーバが同じシミュレーション（minigame/sim.ts）を worker で再生してスコアを決める（申告値は照合だけ）。
 *   速度改造は「刻み数/60 ≦ 発行から提出までの実時間＋10 秒」で弾く。自動操作のボットは防がず、管理者が記録を消せる。
 *
 *   遊び方: 今日のチャレンジ（daily: 全員同じ種、JST 5 時に替わる、ベストだけが順位）と自由プレイ（free: 毎回違う種）。
 *   順位表（minigame_bests.board）: d:日付（今日のチャレンジ）/ w:週の始め（自由、JST 月曜区切り）/ all / all:daily / all:free。
 *   配信: 今日の上位 10 が変わったら 5 秒まとめて全員へ（liveBus の minigame）、本人のベストは本人だけ（personalBus）。
 *   公開後（MINIGAME_ENABLED=1）だけ: チャットへの 1 行（1 位交代・上位 5 位の自己ベスト。1 日 10 行・10 分以内はまとめる）と
 *   月曜 9 時の週の王者の投稿（ビーグル）。
 *   遊んだ人は users.user_id で持つ（配信・API にメールは載せない）。 */
import crypto from "crypto";
import { pool } from "./db";
import { featureEnabledFor, featurePublic } from "./feature-flag";
import { emitLive } from "./live";
import { emitPersonal } from "./personal-live";
import { createPost, SYSTEM_EMAIL } from "./posts";
import { postChatNotice } from "./chat";
import { playersOf } from "./shogi";
import { CHARACTERS, ENGINE_VERSION, MAX_INPUTS, TICK_HZ } from "./minigame/sim";
import { verifyReplay, VerifyTimeout } from "./minigame-verify";
import type {
  BestDto,
  FinishResultDto,
  LeaderboardDto,
  LeaderEntry,
  MinigameInfo,
  MinigameMode,
  MinigamePeriod,
  PlayTicket,
} from "./minigame/types";

export const GAME = "dash";
export const PLAY_TTL_MS = 30 * 60_000;
export const MAX_INPUT_BYTES = 64 * 1024;
export const SPEED_SLACK_SEC = 10;
export const REST_HINT_AFTER = 20;
export const LEADERBOARD_LIMIT = 50;
export const TOP_LIVE = 10;
export const TOP_BROADCAST_DELAY_MS = 5000;
export const ANNOUNCE_MAX_PER_DAY = 10;
export const ANNOUNCE_MERGE_MS = 10 * 60_000;
/** 30 分のうちに出したまま（未提出）の回がこれ以上なら新しく出さない（いたずら防止）。 */
export const MAX_OPEN_PLAYS = 40;
const BEAGLE_NAME = "ビーグル";

/** MINIGAME_ENABLED（読み方は SHOGI_ENABLED と同じ。lib/feature-flag.ts）。 */
export function minigameEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor("MINIGAME_ENABLED", email);
}
export function minigamePublic(): boolean {
  return featurePublic("MINIGAME_ENABLED");
}

export class MinigameError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export type Actor = { email: string; userId: string };

// ───────────────────────────────── 日付（JST）

const H = 3_600_000;
const DAY = 24 * H;

/** 今日のチャレンジの日付（JST 5 時区切り）。 */
export function dailyDate(now = Date.now()): string {
  return new Date(now + 9 * H - 5 * H).toISOString().slice(0, 10);
}
/** その日のチャレンジが始まった時刻（その日の 5:00 JST）。 */
export function dailyStartMs(date: string): number {
  return Date.parse(`${date}T05:00:00+09:00`);
}
/** 次に替わる時刻（翌日 5:00 JST）。 */
export function dailyResetsAt(date: string): string {
  return new Date(dailyStartMs(date) + DAY).toISOString();
}
/** 週の始め（JST 月曜 0 時の日付）。 */
export function weekStart(now = Date.now()): string {
  const j = new Date(now + 9 * H);
  const back = (j.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(j.getUTCFullYear(), j.getUTCMonth(), j.getUTCDate() - back)).toISOString().slice(0, 10);
}

/** 順位表はルールの版ごとに分ける（v2 から名前の頭に "v2:"。v1 の記録は消さずに残るが、表には出ない）。 */
export function boardPrefix(version = ENGINE_VERSION): string {
  return version >= 2 ? `v${version}:` : "";
}

/** 1 回の記録が載る順位表（先頭が「その遊び方の」順位表）。 */
export function boardsFor(mode: MinigameMode, date: string | null, finishedMs: number, version = ENGINE_VERSION): string[] {
  const p = boardPrefix(version);
  if (mode === "daily") return [`${p}d:${date ?? dailyDate(finishedMs)}`, `${p}all`, `${p}all:daily`];
  return [`${p}w:${weekStart(finishedMs)}`, `${p}all`, `${p}all:free`];
}

export function boardFor(period: MinigamePeriod, mode: MinigameMode | null, now = Date.now()): string {
  const p = boardPrefix();
  if (period === "today") return `${p}d:${dailyDate(now)}`;
  if (period === "week") return `${p}w:${weekStart(now)}`;
  return mode ? `${p}all:${mode}` : `${p}all`;
}

// ───────────────────────────────── 種

export async function dailySeed(date: string): Promise<number> {
  await pool.query(`INSERT INTO minigame_daily (date_jst, game, seed) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
    date,
    GAME,
    crypto.randomInt(1, 0x7fffffff),
  ]);
  const r = await pool.query(`SELECT seed FROM minigame_daily WHERE date_jst = $1 AND game = $2`, [date, GAME]);
  return Number(r.rows[0].seed);
}

// ───────────────────────────────── 順位表

type BestRow = { user_id: string; play_id: number; score: number; distance: number; character: string; achieved_at: Date | string };

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : "");

async function topRows(board: string, limit: number): Promise<BestRow[]> {
  const r = await pool.query(
    `SELECT user_id, play_id, score, distance, character, achieved_at FROM minigame_bests
      WHERE game = $1 AND board = $2 ORDER BY score DESC, achieved_at ASC, user_id ASC LIMIT $3`,
    [GAME, board, limit]
  );
  return r.rows as BestRow[];
}

async function toEntries(rows: BestRow[], startRank = 1): Promise<LeaderEntry[]> {
  const players = await playersOf(rows.map((r) => r.user_id));
  return rows.map((r, i) => {
    const p = players.get(r.user_id);
    return {
      rank: startRank + i,
      user_id: r.user_id,
      name: p?.name ?? "（退会した会員）",
      avatar: p?.avatar ?? null,
      score: Number(r.score),
      distance: Number(r.distance),
      character: r.character,
      achieved_at: iso(r.achieved_at),
    };
  });
}

export async function topEntries(board: string, limit: number): Promise<LeaderEntry[]> {
  return toEntries(await topRows(board, limit));
}

/** その人のベストと順位（同点は先に出した人が上）。 */
export async function bestOn(board: string, userId: string): Promise<BestDto | null> {
  const r = await pool.query(
    `SELECT b.play_id, b.score, b.distance, b.character, b.achieved_at,
            (SELECT count(*) FROM minigame_bests x WHERE x.game = b.game AND x.board = b.board
               AND (x.score > b.score OR (x.score = b.score AND (x.achieved_at < b.achieved_at
                    OR (x.achieved_at = b.achieved_at AND x.user_id < b.user_id))))) + 1 AS rank
       FROM minigame_bests b WHERE b.game = $1 AND b.board = $2 AND b.user_id = $3`,
    [GAME, board, userId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    score: Number(row.score),
    distance: Number(row.distance),
    rank: Number(row.rank),
    play_id: Number(row.play_id),
    character: row.character,
    achieved_at: iso(row.achieved_at),
  };
}

export async function getLeaderboard(actor: Actor, periodRaw: unknown, modeRaw: unknown): Promise<LeaderboardDto> {
  const period = periodRaw === "week" || periodRaw === "all" ? periodRaw : periodRaw === "today" || periodRaw == null || periodRaw === "" ? "today" : null;
  if (!period) throw new MinigameError(400, "invalid_request", "period は today / week / all です");
  const mode = modeRaw === "daily" || modeRaw === "free" ? modeRaw : null;
  if (modeRaw != null && modeRaw !== "" && !mode) throw new MinigameError(400, "invalid_request", "mode は daily / free です");
  const now = Date.now();
  const board = boardFor(period, period === "all" ? mode : null, now);
  const entries = await topEntries(board, LEADERBOARD_LIMIT);
  const mine = await bestOn(board, actor.userId);
  return {
    period,
    mode: period === "today" ? "daily" : period === "week" ? "free" : mode,
    key: period === "all" ? null : board.slice(board.lastIndexOf(":") + 1),
    entries,
    me: mine ? { rank: mine.rank ?? 0, score: mine.score, distance: mine.distance } : null,
  };
}

async function playsToday(userId: string, now = Date.now()): Promise<number> {
  const r = await pool.query(
    `SELECT count(*) AS n FROM minigame_plays WHERE user_id = $1 AND game = $2 AND status = 'verified' AND finished_at >= $3`,
    [userId, GAME, new Date(dailyStartMs(dailyDate(now)))]
  );
  return Number(r.rows[0].n);
}

export async function getInfo(actor: Actor): Promise<MinigameInfo> {
  const now = Date.now();
  const date = dailyDate(now);
  const [seed, today, week, all, plays, top, players] = await Promise.all([
    dailySeed(date),
    bestOn(boardFor("today", null, now), actor.userId),
    bestOn(boardFor("week", null, now), actor.userId),
    bestOn(boardFor("all", null, now), actor.userId),
    playsToday(actor.userId, now),
    topEntries(boardFor("today", null, now), 1),
    playersOf([actor.userId]),
  ]);
  return {
    engine_version: ENGINE_VERSION,
    me: { user_id: actor.userId, name: players.get(actor.userId)?.name ?? actor.email.split("@")[0] },
    daily: { date, seed, resets_at: dailyResetsAt(date) },
    best: { today, week, all },
    plays_today: plays,
    top_today: top[0] ?? null,
  };
}

// ───────────────────────────────── 発行

type PlayRow = {
  id: number;
  user_id: string;
  mode: MinigameMode;
  date_jst: string | null;
  seed: number;
  character: string;
  engine_version: number;
  issued_at: Date;
  status: "issued" | "verified" | "rejected";
  db_now: Date;
};

export async function issuePlay(actor: Actor, body: Record<string, unknown>): Promise<PlayTicket> {
  const mode = body.mode;
  if (mode !== "daily" && mode !== "free") throw new MinigameError(400, "invalid_request", "mode は daily / free です");
  const character = body.character;
  if (typeof character !== "string" || !(CHARACTERS as string[]).includes(character)) {
    throw new MinigameError(400, "invalid_request", "character は drikin / matsuo / zenji です");
  }
  const open = await pool.query(
    `SELECT count(*) AS n FROM minigame_plays WHERE user_id = $1 AND status = 'issued' AND issued_at > now() - interval '30 minutes'`,
    [actor.userId]
  );
  if (Number(open.rows[0].n) >= MAX_OPEN_PLAYS) throw new MinigameError(429, "too_many", "少し待ってからどうぞ");
  const date = mode === "daily" ? dailyDate() : null;
  const seed = date ? await dailySeed(date) : crypto.randomInt(1, 0x7fffffff);
  const r = await pool.query(
    `INSERT INTO minigame_plays (user_id, game, mode, date_jst, seed, character, engine_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, issued_at`,
    [actor.userId, GAME, mode, date, seed, character, ENGINE_VERSION]
  );
  const row = r.rows[0];
  return {
    play_id: Number(row.id),
    seed,
    mode,
    character,
    engine_version: ENGINE_VERSION,
    date,
    expires_at: new Date(new Date(row.issued_at).getTime() + PLAY_TTL_MS).toISOString(),
  };
}

async function reject(id: number, reason: string): Promise<void> {
  await pool.query(`UPDATE minigame_plays SET status = 'rejected', reject_reason = $2, finished_at = now() WHERE id = $1 AND status = 'issued'`, [
    id,
    reason,
  ]);
}

// ───────────────────────────────── 提出（検算）

export async function finishPlay(actor: Actor, id: number, body: Record<string, unknown>): Promise<FinishResultDto> {
  const inputs = body.inputs;
  if (!Array.isArray(inputs)) throw new MinigameError(400, "invalid_request", "inputs（操作の記録）がありません");
  if (inputs.length > MAX_INPUTS || JSON.stringify(inputs).length > MAX_INPUT_BYTES) {
    throw new MinigameError(413, "too_large", "記録が大きすぎます");
  }
  const sel = await pool.query(
    `SELECT id, user_id, mode, to_char(date_jst, 'YYYY-MM-DD') AS date_jst, seed, character, engine_version, issued_at, status, now() AS db_now
       FROM minigame_plays WHERE id = $1 AND game = $2`,
    [id, GAME]
  );
  const row = sel.rows[0] as PlayRow | undefined;
  if (!row || row.user_id !== actor.userId) throw new MinigameError(404, "not_found", "見つかりません");
  if (row.status !== "issued") throw new MinigameError(409, "already_finished", "この回はもう記録済みです");
  if (new Date(row.db_now).getTime() - new Date(row.issued_at).getTime() > PLAY_TTL_MS) {
    await reject(id, "expired");
    throw new MinigameError(409, "expired", "時間切れのため記録できません（30 分）");
  }
  if (row.engine_version !== ENGINE_VERSION || Number(body.engine_version) !== ENGINE_VERSION) {
    await reject(id, "engine_version");
    throw new MinigameError(409, "engine_version", "ルール更新のため記録できません");
  }

  let res;
  try {
    res = await verifyReplay(Number(row.seed), row.character, inputs);
  } catch (e) {
    if (e instanceof VerifyTimeout) {
      await reject(id, "timeout");
      throw new MinigameError(422, "invalid_record", "記録を確かめられませんでした");
    }
    console.error("[minigame] verify:", (e as Error)?.message);
    throw new MinigameError(503, "busy", "混み合っています。もう一度どうぞ");
  }
  if (!res.ok) {
    await reject(id, res.error ?? "invalid");
    throw new MinigameError(422, "invalid_record", "記録を確かめられませんでした");
  }
  const claimed = typeof body.score === "number" && Number.isFinite(body.score) ? Math.trunc(body.score) : null;

  // 1 回限り（status = 'issued' のときだけ）・速度改造（刻み数/60 ≦ 実時間 + 10 秒）を 1 文で。
  const up = await pool.query(
    `UPDATE minigame_plays SET status = 'verified', finished_at = now(), ticks = $2, score = $3, distance = $4, sd = $5,
            cause = $6, claimed_score = $7
      WHERE id = $1 AND status = 'issued' AND $2::float8 / ${TICK_HZ} <= extract(epoch from (now() - issued_at)) + ${SPEED_SLACK_SEC}
      RETURNING finished_at`,
    [id, res.ticks, res.score, res.distance, res.sd, res.cause, claimed]
  );
  if (!up.rows[0]) {
    const again = await pool.query(`SELECT status FROM minigame_plays WHERE id = $1`, [id]);
    if (again.rows[0]?.status !== "issued") throw new MinigameError(409, "already_finished", "この回はもう記録済みです");
    await reject(id, "too_fast");
    throw new MinigameError(422, "too_fast", "記録の時間が合いません");
  }
  const finishedAt = new Date(up.rows[0].finished_at);
  const boards = boardsFor(row.mode, row.date_jst, finishedAt.getTime(), row.engine_version);
  const primary = boards[0];

  const prevLeader = row.mode === "daily" ? (await topRows(primary, 1))[0] ?? null : null;
  const newOn: string[] = [];
  for (const board of boards) {
    const r = await pool.query(
      `INSERT INTO minigame_bests (game, board, user_id, play_id, score, distance, character, achieved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (game, board, user_id) DO UPDATE SET play_id = EXCLUDED.play_id, score = EXCLUDED.score,
         distance = EXCLUDED.distance, character = EXCLUDED.character, achieved_at = EXCLUDED.achieved_at
       WHERE EXCLUDED.score > minigame_bests.score
       RETURNING board`,
      [GAME, board, actor.userId, id, res.score, res.distance, row.character, finishedAt]
    );
    if (r.rows[0]) newOn.push(board);
  }
  // 操作の記録は自己ベスト（どれかの順位表に載っている回）の分だけ残す。
  if (newOn.length) {
    await pool.query(`UPDATE minigame_plays SET inputs = $2::jsonb WHERE id = $1`, [id, JSON.stringify(inputs)]);
    await pruneInputs(actor.userId);
  }
  const best = await bestOn(primary, actor.userId);
  const plays = await playsToday(actor.userId);
  const newBest = newOn.includes(primary);
  const out: FinishResultDto = {
    play_id: id,
    mode: row.mode,
    score: res.score,
    distance: res.distance,
    sd: res.sd,
    ticks: res.ticks,
    cause: res.cause,
    best: best?.score ?? res.score,
    new_best: newBest,
    rank: best?.rank ?? null,
    period: row.mode === "daily" ? "today" : "week",
    rank_today: row.mode === "daily" ? (best?.rank ?? null) : null,
    plays_today: plays,
    rest_hint: plays === REST_HINT_AFTER + 1,
    mismatch: claimed !== null && claimed !== res.score,
  };
  if (out.mismatch) console.warn(`[minigame] play ${id}: claimed ${claimed} != replay ${res.score}`);

  if (newBest) {
    emitPersonal(actor.email, {
      type: "minigame",
      action: "best",
      best: { mode: row.mode, score: out.best, distance: best?.distance ?? res.distance, rank: out.rank, period: out.period },
    });
    if (row.mode === "daily" && row.date_jst === dailyDate()) {
      scheduleTopBroadcast();
      void announceDaily(actor, out, best, prevLeader).catch(logErr("announce"));
    }
  }
  return out;
}

async function pruneInputs(userId: string): Promise<void> {
  await pool.query(
    `UPDATE minigame_plays p SET inputs = NULL WHERE p.user_id = $1 AND p.inputs IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM minigame_bests b WHERE b.play_id = p.id)`,
    [userId]
  );
}

// ───────────────────────────────── 配信（今日の上位 10）

const g0 = globalThis as unknown as {
  __bguruMinigame?: { topTimer: ReturnType<typeof setTimeout> | null; topSig: string; sweep: ReturnType<typeof setInterval> | null; chain: Promise<void> };
};
const mem = (g0.__bguruMinigame ??= { topTimer: null, topSig: "", sweep: null, chain: Promise.resolve() });

let topDelay = TOP_BROADCAST_DELAY_MS;
/** テスト用: 上位 10 の配信をまとめる時間。 */
export function _setTopDelayForTest(ms: number): void {
  topDelay = ms;
}

/** 今日の上位 10 が変わったかを 5 秒まとめて確かめ、変わっていれば全員へ配る。 */
export function scheduleTopBroadcast(delayMs = topDelay): void {
  if (mem.topTimer) return;
  mem.topTimer = setTimeout(() => {
    mem.topTimer = null;
    void broadcastTopNow().catch(logErr("top"));
  }, delayMs);
  mem.topTimer.unref?.();
}

export async function broadcastTopNow(): Promise<boolean> {
  const date = dailyDate();
  const top = await topEntries(boardFor("today", null), TOP_LIVE);
  const sig = `${date}|` + top.map((e) => `${e.user_id}:${e.score}`).join(",");
  if (sig === mem.topSig) return false;
  mem.topSig = sig;
  emitLive({ type: "minigame", action: "leaderboard", period: "today", key: date, top });
  return true;
}

// ───────────────────────────────── 公開後にだけ出すもの

function fmt(n: number): string {
  return n.toLocaleString("ja-JP");
}

export function announceText(kind: "leader" | "top5", name: string, score: number, distance: number, rank: number | null): string {
  if (kind === "leader") return `🐶 ${name}さんが「締め切りダッシュ」今日の 1 位に！ ${fmt(score)} 点（${fmt(distance)}m）`;
  return `🐶 ${name}さんが「締め切りダッシュ」今日の ${rank} 位に入ったわん（自己ベスト ${fmt(score)} 点）`;
}

/** 今日のチャレンジの自己ベスト: 1 位交代か、上位 5 位なら、チャットに 1 行（公開後だけ）。 */
async function announceDaily(actor: Actor, out: FinishResultDto, best: BestDto | null, prevLeader: BestRow | null): Promise<void> {
  if (!minigamePublic() || !best?.rank) return;
  const leaderChanged = best.rank === 1 && !!prevLeader && prevLeader.user_id !== actor.userId;
  if (!leaderChanged && best.rank > 5) return;
  const name = (await playersOf([actor.userId])).get(actor.userId)?.name ?? "だれか";
  await postAnnounce(announceText(leaderChanged ? "leader" : "top5", name, best.score, best.distance, best.rank));
}

/** 1 日 10 行まで。前の行から 10 分以内なら、その行を書き換えて最後の 1 回にまとめる。 */
export function postAnnounce(text: string, now = Date.now()): Promise<void> {
  const run = mem.chain.then(async () => {
    const date = dailyDate(now);
    await pool.query(`INSERT INTO minigame_announces (date_jst, game) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [date, GAME]);
    const r = await pool.query(`SELECT lines, last_msg_id, last_at FROM minigame_announces WHERE date_jst = $1 AND game = $2`, [date, GAME]);
    const a = r.rows[0] as { lines: number; last_msg_id: number | null; last_at: Date | null };
    if (a.last_msg_id && a.last_at && now - new Date(a.last_at).getTime() < ANNOUNCE_MERGE_MS) {
      const edited = await postChatNotice(text, a.last_msg_id);
      if (edited) {
        await pool.query(`UPDATE minigame_announces SET last_at = $3 WHERE date_jst = $1 AND game = $2`, [date, GAME, new Date(now)]);
        return;
      }
    }
    if (a.lines >= ANNOUNCE_MAX_PER_DAY) return;
    const msg = await postChatNotice(text);
    if (!msg) return;
    await pool.query(
      `UPDATE minigame_announces SET lines = lines + 1, last_msg_id = $3, last_at = $4 WHERE date_jst = $1 AND game = $2`,
      [date, GAME, msg.id, new Date(now)]
    );
  });
  mem.chain = run.catch(() => {});
  return run;
}

export function weeklyText(top: LeaderEntry[]): string {
  const [k, ...rest] = top;
  const lines = [`🏆 先週の「締め切りダッシュ」王者は ${k.name}さん！ ${fmt(k.score)} 点（${fmt(k.distance)}m）`];
  for (const e of rest) lines.push(`${e.rank} 位 ${e.name}さん ${fmt(e.score)} 点`);
  lines.push("今週も締め切りから逃げ切るわん🐶（自由プレイの週間ランキング・月曜 0 時区切り）");
  return lines.join("\n");
}

/** 月曜 9 時（JST）を過ぎたら、先週の王者をビーグルがタイムラインに 1 本だけ投稿する（公開後だけ）。 */
export async function weeklyKingCheck(now = Date.now()): Promise<number | null> {
  if (!minigamePublic()) return null;
  const thisWeek = weekStart(now);
  if (now < Date.parse(`${thisWeek}T09:00:00+09:00`)) return null;
  const prev = weekStart(now - 7 * DAY);
  const top = await topEntries(`${boardPrefix()}w:${prev}`, 3);
  if (top.length === 0) return null;
  // 先に週の行を取る（二重投稿しない。取れなければもう投稿済み）
  const reserve = await pool.query(
    `INSERT INTO minigame_weekly (week_start, game) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING week_start`,
    [prev, GAME]
  );
  if (!reserve.rows[0]) return null;
  const p = await createPost({ authorEmail: SYSTEM_EMAIL, authorName: BEAGLE_NAME, text: weeklyText(top), noPreview: true });
  await pool.query(`UPDATE minigame_weekly SET post_id = $3 WHERE week_start = $1 AND game = $2`, [prev, GAME, p.id]);
  emitLive({ type: "post", postId: p.id, action: "create", authorId: p.authorId });
  return p.id;
}

// ───────────────────────────────── 管理（管理者だけ）

export async function adminListPlays(userId: string | null, limit: number) {
  const n = Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.trunc(limit) : 50));
  const r = await pool.query(
    `SELECT id, user_id, mode, to_char(date_jst, 'YYYY-MM-DD') AS date_jst, character, score, distance, ticks, claimed_score,
            status, reject_reason, issued_at, finished_at, (inputs IS NOT NULL) AS has_inputs
       FROM minigame_plays WHERE game = $1 AND ($2::text IS NULL OR user_id = $2) AND status <> 'issued'
       ORDER BY id DESC LIMIT $3`,
    [GAME, userId, n]
  );
  const players = await playersOf(r.rows.map((x) => x.user_id as string));
  return r.rows.map((x) => ({
    id: Number(x.id),
    user_id: x.user_id as string,
    name: players.get(x.user_id)?.name ?? null,
    mode: x.mode,
    date: x.date_jst,
    character: x.character,
    score: x.score,
    distance: x.distance,
    ticks: x.ticks,
    claimed_score: x.claimed_score,
    status: x.status,
    reject_reason: x.reject_reason,
    issued_at: iso(x.issued_at),
    finished_at: iso(x.finished_at),
    has_inputs: x.has_inputs,
  }));
}

/** その人の順位表を、残っている記録（verified）から作り直す。 */
export async function recomputeBests(userId: string): Promise<void> {
  await pool.query(`DELETE FROM minigame_bests WHERE game = $1 AND user_id = $2`, [GAME, userId]);
  const r = await pool.query(
    `SELECT id, mode, to_char(date_jst, 'YYYY-MM-DD') AS date_jst, character, score, distance, finished_at, engine_version
       FROM minigame_plays WHERE game = $1 AND user_id = $2 AND status = 'verified' ORDER BY finished_at ASC, id ASC`,
    [GAME, userId]
  );
  const best = new Map<string, { id: number; score: number; distance: number; character: string; at: Date }>();
  for (const p of r.rows) {
    const at = new Date(p.finished_at);
    for (const b of boardsFor(p.mode, p.date_jst, at.getTime(), Number(p.engine_version))) {
      const cur = best.get(b);
      if (!cur || Number(p.score) > cur.score) best.set(b, { id: Number(p.id), score: Number(p.score), distance: Number(p.distance), character: p.character, at });
    }
  }
  for (const [board, b] of best) {
    await pool.query(
      `INSERT INTO minigame_bests (game, board, user_id, play_id, score, distance, character, achieved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [GAME, board, userId, b.id, b.score, b.distance, b.character, b.at]
    );
  }
  await pruneInputs(userId);
}

export async function adminRejectPlay(id: number): Promise<{ id: number; user_id: string }> {
  const r = await pool.query(
    `UPDATE minigame_plays SET status = 'rejected', reject_reason = 'admin', inputs = NULL WHERE id = $1 AND game = $2 AND status = 'verified'
     RETURNING user_id`,
    [id, GAME]
  );
  if (!r.rows[0]) throw new MinigameError(404, "not_found", "記録が見つかりません");
  await recomputeBests(r.rows[0].user_id);
  mem.topSig = "";
  await broadcastTopNow();
  return { id, user_id: r.rows[0].user_id };
}

export async function adminClearUser(userId: string): Promise<{ user_id: string; rejected: number }> {
  const r = await pool.query(
    `UPDATE minigame_plays SET status = 'rejected', reject_reason = 'admin', inputs = NULL WHERE user_id = $1 AND game = $2 AND status = 'verified'`,
    [userId, GAME]
  );
  await pool.query(`DELETE FROM minigame_bests WHERE game = $1 AND user_id = $2`, [GAME, userId]);
  mem.topSig = "";
  await broadcastTopNow();
  return { user_id: userId, rejected: r.rowCount ?? 0 };
}

// ───────────────────────────────── 見回り

function logErr(where: string) {
  return (e: unknown) => console.error(`[minigame] ${where}:`, (e as Error)?.message);
}

/** プロセスに 1 つ: 1 分ごとに週の王者の投稿を確かめ、期限切れの発行を片付ける。 */
export function ensureMinigameSweeper(): void {
  if (mem.sweep) return;
  mem.sweep = setInterval(async () => {
    try {
      await weeklyKingCheck();
      await pool.query(`DELETE FROM minigame_plays WHERE status = 'issued' AND issued_at < now() - interval '1 day'`);
    } catch (e) {
      logErr("sweeper")(e);
    }
  }, 60_000);
  mem.sweep.unref?.();
}

/** テスト用: メモリの状態を消す。 */
export function _resetMinigameForTest(): void {
  if (mem.topTimer) clearTimeout(mem.topTimer);
  mem.topTimer = null;
  mem.topSig = "";
  if (mem.sweep) clearInterval(mem.sweep);
  mem.sweep = null;
  mem.chain = Promise.resolve();
}
