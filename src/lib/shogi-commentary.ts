/* ☗ ビーグルの実況 — 作って配る（docs/shogi-spec.md「ビーグルの実況」）。
 *
 *   指し手の確定（コミット・配信）の「あと」に shogi.ts が非同期で依頼する（指し手の処理は待たない・遅らせない）。
 *   1. 最新だけ: 対局ごとに同時に 1 つ。新しい手が来たら古い方は打ち切る（AI の呼び出しも abort、待っている依頼は捨てる）。
 *   2. 評価: ビーグルの探索（worker、乱数なし・深さ 3・400ms まで）。ビーグルがどこかの対局で考え中なら終わるまで待つ
 *      （ビーグルの手が最優先。探索をぶつけない）。実況の評価は時間切れでも worker を捨てない（結果を捨てるだけ）。
 *   3. ひな形を先に: 評価が出たらすぐ事実からのひな形の文を保存・配信（帯が毎手必ず更新される）。
 *   4. AI（さくらの AI Engine、ビーグルと同じ sakuraChat・SAKURA_MODEL。思考は少なめ reasoning_effort: low）に事実だけを渡し、
 *      検査を通ったら同じ手の実況を AI の文に置き換えて配り直す。対局者の名前は AI に渡さない（「先手」「後手」→ あとで差し替え）。
 *      費用の上限: 1 日の呼び出し数（SHOGI_COMMENTARY_DAILY_AI、既定 600）、連続 5 回の失敗（空・429・タイムアウトなど）で
 *      10 分止める。公開前は、実況を見せる人（フラグのメール）が対局者か観戦中の対局だけ AI を呼ぶ。
 *   5. 見どころ（形勢逆転・詰み筋）だけ、公開後に 1 局 2 件までチャットへ（間を 4 分あける。1 手ずつは流さない）。
 *      終局は既存の終局カード・ビーグルの投稿（「分かれ目」）にまとめる。 */
import { pool } from "./db";
import { sakuraChat, SAKURA_MODEL, type ChatTurn } from "./sakura";
import { emitLive } from "./live";
import { INITIAL_SFEN, sideToMove, otherSide, type Side } from "./shogi-rules";
import { MATE_BOUND } from "./shogi-engine";
import { beagleEvaluate } from "./shogi-beagle-think";
import { beagleThinkingAny } from "./shogi-beagle";
import { isSelfGame, loadGame, playersOf, shogiPublic, watcherIds, type GameRow } from "./shogi";
import {
  AI_SYSTEM_PROMPT,
  LatestOnly,
  aiUserPrompt,
  bestLabel,
  checkAiText,
  detectHighlight,
  endTemplateText,
  evalForBlack,
  moveFacts,
  templateText,
  withTimeout,
  type CommentaryFacts,
  type LatestJob,
} from "./shogi-commentary-core";
import {
  commentaryAt,
  commentaryFlagEmails,
  commentaryOn,
  commentaryPublic,
  postHighlightIfActive,
  saveCommentary,
  toCommentaryDto,
  type CommentaryRow,
} from "./shogi-commentary-store";

/** 局面の評価にかける時間の上限（ms）。CPU を食いすぎない（ビーグルが指すときの 1/4〜1/6）。 */
export const EVAL_TIME_MS = 400;
/** AI の返事を待つ上限（ms）。 */
export const AI_TIMEOUT_MS = 12_000;
/** ビーグルが考え終わるのを待つ上限（ms）。 */
const BEAGLE_WAIT_MS = 8_000;
/** 1 日の AI 呼び出しの既定の上限（SHOGI_COMMENTARY_DAILY_AI で変える。0 で AI を使わない）。 */
export const DEFAULT_DAILY_AI = 600;
/** この回数続けて失敗したら AI を止める。 */
export const BREAKER_FAILS = 5;
/** 止める時間。 */
export const BREAKER_MS = 10 * 60_000;
/** gpt-oss（推論型）は思考にも token を使う。思考を少なめにしたうえで余裕を持たせる。 */
const AI_MAX_TOKENS = 2000;

type Job = LatestJob & { kind: "move" | "end" };
export type CommentaryAi = (messages: ChatTurn[], signal: AbortSignal) => Promise<string>;

type Mem = {
  runners: Map<number, LatestOnly<Job>>;
  ai: CommentaryAi | null;
  aiCalls: number;
  aiTimeoutMs: number | null;
  dropped: number;
  day: string;
  dayCount: number;
  failStreak: number;
  breakerUntil: number;
  /** さくらが reasoning_effort を受け付けなかった（400）: 以後は送らない。 */
  noEffort: boolean;
};
const g0 = globalThis as unknown as { __bguruShogiCommentary2?: Mem };
const fresh = (): Mem => ({
  runners: new Map(),
  ai: null,
  aiCalls: 0,
  aiTimeoutMs: null,
  dropped: 0,
  day: "",
  dayCount: 0,
  failStreak: 0,
  breakerUntil: 0,
  noEffort: false,
});
let mem: Mem = (g0.__bguruShogiCommentary2 ??= fresh());

function logErr(where: string) {
  return (e: unknown) => console.error(`[shogi commentary] ${where}:`, (e as Error)?.message);
}

/** 対局ごとの「最新だけ」。依頼がなくなったら片付ける。 */
function runnerFor(gameId: number): LatestOnly<Job> {
  let r = mem.runners.get(gameId);
  if (!r) {
    const made: LatestOnly<Job> = new LatestOnly<Job>(
      (job, signal) => (job.kind === "end" ? runEnd(job, signal) : runMove(job, signal)),
      logErr("job"),
      () => {
        mem.dropped += made.dropped;
        made.dropped = 0;
        if (mem.runners.get(gameId) === made) mem.runners.delete(gameId);
      }
    );
    r = made;
    mem.runners.set(gameId, r);
  }
  return r;
}

/** 既定の AI: ビーグルと同じクライアント（sakuraChat）・同じモデル設定（SAKURA_MODEL）。テストでは外に出ない。 */
const defaultAi: CommentaryAi = async (messages, signal) => {
  if (process.env.VITEST) throw new Error("AI is disabled in tests");
  const call = (effort: boolean) =>
    sakuraChat({
      model: SAKURA_MODEL,
      messages,
      temperature: 0.7,
      max_tokens: AI_MAX_TOKENS,
      signal,
      ...(effort ? { reasoning_effort: "low" as const } : {}),
    });
  try {
    return (await call(!mem.noEffort)).content;
  } catch (e) {
    const msg = String((e as Error)?.message ?? "");
    if (!mem.noEffort && /error 400/.test(msg) && /reasoning/i.test(msg) && !signal.aborted) {
      mem.noEffort = true; // このモデル・API では受け付けない: 送らずにやり直す
      return (await call(false)).content;
    }
    throw e;
  }
};

/** 指し手が確定した（shogi.ts の playMove から。待たない）。 */
export function queueMoveCommentary(gameId: number, ply: number): void {
  if (!commentaryOn() || ply < 1) return;
  runnerFor(gameId).submit({ gameId, ply, kind: "move" });
}

/** 指し手でない終わり方（投了・時間切れ・放置）。中断は実況を取り消す。 */
export function queueEndCommentary(r: Pick<GameRow, "id" | "ply" | "end_reason">): void {
  if (!commentaryOn()) return;
  if (r.end_reason === "aborted" || r.ply < 1) {
    mem.runners.get(r.id)?.cancel(r.id);
    return;
  }
  if (r.end_reason === "resign" || r.end_reason === "timeout" || r.end_reason === "abandon") {
    runnerFor(r.id).submit({ gameId: r.id, ply: r.ply, kind: "end" });
  }
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

/** ビーグルがどこかで考えている間は待つ（ビーグルの手が最優先）。 */
async function waitBeagle(signal: AbortSignal): Promise<void> {
  const until = Date.now() + BEAGLE_WAIT_MS;
  while (beagleThinkingAny() && Date.now() < until && !signal.aborted) await sleep(100);
}

async function namesOf(r: GameRow): Promise<{ black: string; white: string }> {
  const players = await playersOf([r.black_uid, r.white_uid]);
  return { black: players.get(r.black_uid ?? "")?.name ?? "先手", white: players.get(r.white_uid ?? "")?.name ?? "後手" };
}

// ─────────────────────────── AI の費用の上限

/** 日本時間の日付（1 日の上限の区切り）。 */
const jstDay = (now: number) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);

export function dailyAiLimit(): number {
  const v = (process.env.SHOGI_COMMENTARY_DAILY_AI ?? "").trim();
  if (!v) return DEFAULT_DAILY_AI;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_AI;
}

/** 今 AI を呼んでよいか（遮断中・1 日の上限・公開前は見せる人が対局者か観戦中の対局だけ）。 */
async function aiAllowed(r: GameRow, now = Date.now()): Promise<boolean> {
  if (now < mem.breakerUntil) return false;
  if (mem.day !== jstDay(now)) {
    mem.day = jstDay(now);
    mem.dayCount = 0;
  }
  if (mem.dayCount >= dailyAiLimit()) return false;
  if (commentaryPublic()) return true;
  const emails = commentaryFlagEmails();
  if (emails.size === 0) return false;
  const people = await playersOf([r.black_uid, r.white_uid, ...watcherIds(r.id, now)]);
  return [...people.values()].some((p) => emails.has(p.email.toLowerCase()));
}

function aiFailed(): void {
  mem.failStreak++;
  if (mem.failStreak >= BREAKER_FAILS) {
    mem.breakerUntil = Date.now() + BREAKER_MS;
    mem.failStreak = 0;
    console.error(`[shogi commentary] AI failed ${BREAKER_FAILS} times in a row: templates only for ${BREAKER_MS / 60000} min`);
  }
}

/** AI に文を頼み、検査する（名前は渡さない。通った文は表示名に差し替え済み）。だめなら null。 */
async function aiText(f: CommentaryFacts, signal: AbortSignal): Promise<string | null> {
  const ai = mem.ai ?? defaultAi;
  const t = withTimeout(signal, mem.aiTimeoutMs ?? AI_TIMEOUT_MS);
  try {
    mem.aiCalls++;
    mem.dayCount++;
    const raw = await ai(
      [
        { role: "system", content: AI_SYSTEM_PROMPT },
        { role: "user", content: aiUserPrompt(f) },
      ],
      t.signal
    );
    if (signal.aborted) return null; // 新しい手が来た（失敗には数えない）
    const c = checkAiText(raw, f);
    if (!c.ok) {
      if (c.reason === "empty") aiFailed();
      else mem.failStreak = 0; // 返事はあった（中身がだめなだけ）
      console.error(`[shogi commentary] AI text rejected (${c.reason}) ply ${f.ply}`);
      return null;
    }
    mem.failStreak = 0;
    return c.text;
  } catch (e) {
    if (signal.aborted) return null; // 新しい手が来た（失敗には数えない）
    aiFailed(); // 429・タイムアウト・空（sakuraChat は空で throw）など
    console.error("[shogi commentary] AI:", (e as Error)?.message);
    return null;
  } finally {
    t.dispose();
  }
}

// ─────────────────────────── 1 手ぶん

async function runMove(job: Job, signal: AbortSignal): Promise<void> {
  const r = await loadGame(job.gameId);
  if (!r || !r.black_uid || !r.white_uid || r.ply < job.ply) return;
  const mv = await pool.query(
    `SELECT ply, usi, label, sfen_after FROM shogi_moves WHERE game_id = $1 AND ply BETWEEN $2 - 1 AND $2 ORDER BY ply`,
    [job.gameId, job.ply]
  );
  const cur = mv.rows.find((m) => m.ply === job.ply) as { usi: string; label: string; sfen_after: string } | undefined;
  if (!cur) return;
  const prev = mv.rows.find((m) => m.ply === job.ply - 1) as { usi: string; label: string; sfen_after: string } | undefined;
  const mf = moveFacts(prev?.sfen_after ?? INITIAL_SFEN, cur.usi);
  const prevC = job.ply > 1 ? await commentaryAt(job.gameId, job.ply - 1) : null;
  const mover: Side = sideToMove(job.ply - 1);

  // ビーグルが考えている間は探索をぶつけない（待つ間に次の手が来たら、この手は次の手に任せる）。
  await waitBeagle(signal);
  if (signal.aborted) return;
  const res = await beagleEvaluate(cur.sfen_after, EVAL_TIME_MS);

  let evalAfter: number | null = null;
  let best: { usi: string; label: string } | null = null;
  if (res) {
    evalAfter = evalForBlack(res.score, otherSide(mover), MATE_BOUND);
    if (res.usi) best = { usi: res.usi, label: bestLabel(cur.sfen_after, res.usi, cur.usi) ?? "" };
    else if (mf?.check) evalAfter = evalForBlack(Number.MAX_SAFE_INTEGER, mover, MATE_BOUND); // 合法手なし＝詰み（指した側の勝ち）
  }
  const names = await namesOf(r);
  const endedHere = r.status === "ended" && r.ply === job.ply;
  const facts: CommentaryFacts = {
    ply: job.ply,
    mover,
    blackName: names.black,
    whiteName: names.white,
    moveLabel: cur.label,
    prevMoveLabel: prev?.label ?? null,
    capture: mf?.capture ?? null,
    check: !!mf?.check,
    evalBefore: prevC?.eval_cp ?? (job.ply === 1 ? 0 : null),
    evalAfter,
    bestPrevLabel: prevC?.best_label ?? null,
    bestNextLabel: endedHere ? null : best?.label || null,
    mode: r.mode,
    clocks: r.mode === "blitz" ? { black_ms: r.clock_b_ms, white_ms: r.clock_w_ms } : null,
    end: endedHere ? { result: r.result, reason: r.end_reason ?? "" } : null,
  };
  const hl = detectHighlight(facts.evalBefore, evalAfter);
  const base = {
    game_id: job.gameId,
    ply: job.ply,
    move_label: cur.label,
    eval_cp: evalAfter,
    best_usi: endedHere ? null : best?.usi ?? null,
    best_label: endedHere ? null : best?.label || null,
    highlight: hl,
  };

  // ひな形を先に（帯が毎手必ず更新される）。
  let row = await saveCommentary({ ...base, text: templateText(facts), source: "template" });
  publish(row);

  // 終局の手（詰み・千日手）はひな形のまま（勝ち負けを言い違えない）。それ以外は AI → 検査 → 通ったら置き換え。
  if (!endedHere && !signal.aborted && (await aiAllowed(r))) {
    const ai = await aiText(facts, signal);
    if (ai && !signal.aborted) {
      row = await saveCommentary({ ...base, text: ai, source: "ai" });
      publish(row);
    }
  }
  if (hl && !endedHere) await maybeChat(r, row, names).catch(logErr("chat"));
}

async function runEnd(job: Job, signal: AbortSignal): Promise<void> {
  const r = await loadGame(job.gameId);
  if (!r || r.status !== "ended" || !r.black_uid || !r.white_uid) return;
  const names = await namesOf(r);
  const prev = await commentaryAt(job.gameId, job.ply);
  if (signal.aborted) return;
  const text = endTemplateText({ result: r.result, reason: r.end_reason ?? "", ply: r.ply, blackName: names.black, whiteName: names.white });
  const row = await saveCommentary({
    game_id: job.gameId,
    ply: job.ply,
    move_label: r.last_label ?? prev?.move_label ?? "",
    text,
    eval_cp: prev?.eval_cp ?? null,
    best_usi: null,
    best_label: null,
    source: "template",
    highlight: prev?.highlight ?? null,
  });
  publish(row);
}

function publish(row: CommentaryRow): void {
  emitLive({ type: "shogi_commentary", gameId: row.game_id, commentary: toCommentaryDto(row) });
}

/** 見どころをチャットに 1 行（公開後・自分との対局でない・対局中だけ。1 局 2 件まで・間を 4 分あける）。
 *  「対局中か」は投稿する同じトランザクションで対局の行をロックして確かめる（終局カードのあとに割り込まない）。 */
async function maybeChat(r: GameRow, row: CommentaryRow, names: { black: string; white: string }): Promise<void> {
  if (!commentaryPublic() || !shogiPublic() || isSelfGame(r)) return;
  await postHighlightIfActive(r.id, `🐶 ビーグルの実況（☗${names.black} vs ☖${names.white}・${row.ply} 手目）${row.text}`);
}

// ─────────────────────────── テスト用

export function _setCommentaryAiForTest(fn: CommentaryAi | null, timeoutMs: number | null = null): void {
  mem.ai = fn;
  mem.aiTimeoutMs = timeoutMs;
}

export function _commentaryStatsForTest(): { aiCalls: number; dropped: number; dayCount: number; breakerUntil: number } {
  let dropped = mem.dropped;
  for (const r of mem.runners.values()) dropped += r.dropped;
  return { aiCalls: mem.aiCalls, dropped, dayCount: mem.dayCount, breakerUntil: mem.breakerUntil };
}

/** 依頼がすべて終わるまで待つ（テスト用）。 */
export async function commentaryIdle(): Promise<void> {
  while ([...mem.runners.values()].some((r) => r.busy)) {
    for (const r of [...mem.runners.values()]) await r.idle();
  }
}

export function _resetCommentaryForTest(): void {
  mem = g0.__bguruShogiCommentary2 = fresh();
}
