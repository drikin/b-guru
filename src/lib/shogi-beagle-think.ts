/* ☗ ビーグルが 1 手を考える（探索を別スレッドで動かし、選んだ手を tsshogi で確かめる）。
 *
 *   - 探索は worker_threads の別スレッド（イベントループを止めない）。worker は 1 つ（ビーグル戦はサイト全体で 1 局）。
 *   - 1 手の考える時間には上限（thinkBudgetMs）。worker が落ちた・返事が来ないときは、
 *     その場で「1 手読み＋取り合い」のすぐ指せる手（取る手優先、100ms まで）を選ぶ。
 *   - 選んだ手は必ず shogi-rules（tsshogi）の合法手に入っているか確かめる。入っていなければ
 *     すぐ指せる手 → tsshogi の合法手から取る手 → どれか、の順に選び直す（反則をしない）。
 *   - テスト（vitest）や SHOGI_BEAGLE_INLINE=1 では worker を使わず、同じ探索をその場で動かす。 */
import { Worker } from "node:worker_threads";
import { Position } from "tsshogi";
import { beagleQuickMove, beagleSearch, type BeagleSearchOptions, type BeagleSearchResult } from "./shogi-engine";
import { legalMovesOf } from "./shogi-rules";
import { BEAGLE_WORKER_SRC } from "./shogi-beagle-worker.generated";

/** 考える時間の上限（ms）。速い将棋: 持ち時間が多ければ 2.5 秒、少なければ短く、秒読みでは 5 秒以内（残りの 1/4 まで）。 */
export function thinkBudgetMs(g: { mode: "blitz" | "slow"; mainLeftMs: number | null; byoyomiLeftMs: number | null }): number {
  if (g.mode === "slow") return 3000;
  if (g.mainLeftMs == null) return 1500; // 時計が動く前（1 手目・2 手目）
  if (g.mainLeftMs > 0) {
    if (g.mainLeftMs >= 120_000) return 2500;
    return Math.max(300, Math.min(2500, Math.floor(g.mainLeftMs / 30)));
  }
  const byo = g.byoyomiLeftMs ?? 0;
  return Math.max(200, Math.min(5000, Math.floor(byo / 4)));
}

/** 「考えている」間（0.8〜2 秒）。探索と並べて待ち、指すのは両方が終わってから。時間の上限は超えない。 */
export function thinkDelayMs(budgetMs: number, rand = Math.random): number {
  const d = 800 + Math.floor(rand() * 1200);
  return Math.min(d, Math.max(0, budgetMs));
}

export type BeagleThought = {
  usi: string | null;
  result: BeagleSearchResult | null;
  /** worker = 別スレッドの探索、inline = その場の探索（テスト）、fallback = worker がだめですぐ指せる手、
   *  rules = 探索の手が tsshogi で通らず tsshogi の合法手から選んだ。 */
  source: "worker" | "inline" | "fallback" | "rules";
};

type Pending = { worker: Worker; resolve: (r: BeagleSearchResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };
type WorkerState = { worker: Worker | null; seq: number; pending: Map<number, Pending>; broken: boolean };
const g0 = globalThis as unknown as { __bguruBeagleWorker?: WorkerState };
const ws: WorkerState = (g0.__bguruBeagleWorker ??= { worker: null, seq: 0, pending: new Map(), broken: false });

function inlineMode(): boolean {
  return process.env.SHOGI_BEAGLE_INLINE === "1" || (!!process.env.VITEST && process.env.SHOGI_BEAGLE_WORKER !== "1");
}

/** その worker に頼んでいた探索をすべて失敗にする（w を省くと全部）。 */
function failAll(err: Error, w?: Worker) {
  for (const [id, p] of ws.pending) {
    if (w && p.worker !== w) continue;
    clearTimeout(p.timer);
    ws.pending.delete(id);
    p.reject(err);
  }
}

function getWorker(): Worker {
  if (ws.worker) return ws.worker;
  const w = new Worker(BEAGLE_WORKER_SRC, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  w.unref();
  w.on("message", (msg: { id: number; ok: boolean; result?: BeagleSearchResult; error?: string }) => {
    const p = ws.pending.get(msg.id);
    if (!p) return;
    ws.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok && msg.result) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "worker error"));
  });
  const drop = (why: string) => (e?: unknown) => {
    if (ws.worker === w) ws.worker = null;
    failAll(new Error(`${why}: ${(e as Error)?.message ?? e ?? ""}`), w);
  };
  w.on("error", drop("worker error"));
  w.on("exit", drop("worker exit"));
  ws.worker = w;
  return w;
}

/** 別スレッドで探索する。timeoutMs で返事がなければ worker を捨てて reject。 */
export function searchInWorker(sfen: string, opts: BeagleSearchOptions, timeoutMs: number): Promise<BeagleSearchResult> {
  return new Promise((resolve, reject) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      reject(e as Error);
      return;
    }
    const id = ++ws.seq;
    const timer = setTimeout(() => {
      ws.pending.delete(id);
      // 探索が止まらない worker は捨てる（次の手で作り直す）
      if (ws.worker === w) ws.worker = null;
      void w.terminate().catch(() => {});
      reject(new Error("worker timeout"));
    }, timeoutMs);
    timer.unref?.();
    ws.pending.set(id, { worker: w, resolve, reject, timer });
    w.postMessage({ id, sfen, opts });
  });
}

/** tsshogi の合法手（USI）。 */
function rulesLegal(sfen: string): { usis: string[]; captures: string[] } {
  const pos = Position.newBySFEN(sfen);
  if (!pos) return { usis: [], captures: [] };
  const ms = legalMovesOf(pos);
  return { usis: ms.map((m) => m.usi), captures: ms.filter((m) => !!pos.board.at(m.to)).map((m) => m.usi) };
}

/** 1 手を考える。budgetMs = 探索の上限。合法手がなければ usi は null。 */
export async function beagleThink(
  sfen: string,
  budgetMs: number,
  opts: { inline?: boolean; /** テスト用: 返事を待つ時間 */ workerTimeoutMs?: number } = {}
): Promise<BeagleThought> {
  const searchOpts: BeagleSearchOptions = { timeMs: budgetMs, maxDepth: 3 };
  let result: BeagleSearchResult | null = null;
  let source: BeagleThought["source"] = "worker";
  if (opts.inline ?? inlineMode()) {
    source = "inline";
    result = beagleSearch(sfen, searchOpts);
  } else {
    try {
      // 探索は自分で時間を守る。返事の遅れの余裕を 1.5 秒みる。
      result = await searchInWorker(sfen, searchOpts, opts.workerTimeoutMs ?? budgetMs + 1500);
    } catch (e) {
      console.error("[shogi beagle] worker:", (e as Error)?.message);
      source = "fallback";
      result = null;
    }
  }
  const legal = rulesLegal(sfen);
  if (legal.usis.length === 0) return { usi: null, result, source };
  if (result?.usi && legal.usis.includes(result.usi)) return { usi: result.usi, result, source };
  if (result?.usi) console.error("[shogi beagle] engine move rejected by rules:", result.usi, sfen);
  const quick = beagleQuickMove(sfen);
  if (quick && legal.usis.includes(quick)) return { usi: quick, result, source: "fallback" };
  const pick = legal.captures[0] ?? legal.usis[Math.floor(Math.random() * legal.usis.length)];
  return { usi: pick, result, source: "rules" };
}

/** テスト用: worker を止める。 */
export async function _stopBeagleWorker(): Promise<void> {
  const w = ws.worker;
  ws.worker = null;
  failAll(new Error("stopped"));
  if (w) await w.terminate().catch(() => {});
}
