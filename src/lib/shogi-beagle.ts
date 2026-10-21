/* ☗ ビーグルの手番（ビーグル戦の指し手を、人と同じ playMove で指す）。docs/shogi-spec.md「ビーグル戦」。
 *
 *   呼ばれるのは shogi.ts の kickBeagle から: 人が指した直後、ビーグルが先手で始まったとき、
 *   起動時（shogiReady）と 1 分ごとの見回り（手番がビーグルのまま止まっていないか）。
 *   1. 対局を読み直し、手番がビーグルでなければ何もしない（同じ対局は同時に 1 つしか考えない）。
 *   2. 残り時間から考える時間の上限を決め（thinkBudgetMs）、探索（別スレッド）と「考えている」間（0.8〜2 秒）を並べて待つ。
 *   3. 大差で負けが決まっていれば投了。そうでなければ expected_ply と client_move_id（beagle-{id}-{ply}）で指す
 *      （二重に指さない。手数が進んでいれば 409 で何もしない）。時計は人と同じく減る。 */
import { beagleActor, beagleSide, loadGame, playMove, resignGame, ShogiError, clockOf } from "./shogi";
import { remainingAt } from "./shogi-clock";
import { sideToMove } from "./shogi-rules";
import { MATE_BOUND } from "./shogi-engine";
import { beagleThink, thinkBudgetMs, thinkDelayMs, type BeagleThought } from "./shogi-beagle-think";

type BeagleMemory = {
  thinking: Set<number>;
  inflight: Set<Promise<void>>;
  /** テスト用: 「考えている」間を固定する（ms）。 */
  delayMs: number | null;
};
const g0 = globalThis as unknown as { __bguruBeagle?: BeagleMemory };
const mem: BeagleMemory = (g0.__bguruBeagle ??= { thinking: new Set(), inflight: new Set(), delayMs: null });

function logErr(where: string) {
  return (e: unknown) => console.error(`[shogi beagle] ${where}:`, (e as Error)?.message);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 投了するか: 詰みを読まれていて駒も大きく損している、または駒の損が非常に大きい（序盤は投了しない）。 */
export function shouldResign(t: BeagleThought, ply: number): boolean {
  const r = t.result;
  if (!r || ply < 30) return false;
  if (r.score <= -MATE_BOUND && r.material <= -800) return true;
  return r.material <= -3000 && r.score <= -2500;
}

/** ビーグルの番なら 1 手指す（考え中なら何もしない）。 */
export function beagleTurn(gameId: number): Promise<void> {
  if (mem.thinking.has(gameId)) return Promise.resolve();
  mem.thinking.add(gameId);
  const p = runTurn(gameId)
    .catch(logErr(`game ${gameId}`))
    .finally(() => {
      mem.thinking.delete(gameId);
      mem.inflight.delete(p);
    });
  mem.inflight.add(p);
  return p;
}

async function runTurn(id: number): Promise<void> {
  const actor = beagleActor();
  if (!actor) return;
  const r = await loadGame(id);
  if (!r || r.status !== "active") return;
  const side = beagleSide(r);
  if (!side || sideToMove(r.ply) !== side) return;

  const now = r.db_now ? new Date(r.db_now).getTime() : Date.now();
  const clock = clockOf(r);
  let mainLeftMs: number | null = null;
  let byoyomiLeftMs: number | null = null;
  if (r.mode === "blitz" && r.ply >= 2) {
    const rem = remainingAt(clock, now);
    mainLeftMs = side === "black" ? rem.black_ms : rem.white_ms;
    byoyomiLeftMs = rem.byoyomi_left_ms;
  }
  const budget = thinkBudgetMs({ mode: r.mode, mainLeftMs, byoyomiLeftMs });
  const delay = mem.delayMs ?? thinkDelayMs(budget);
  const [thought] = await Promise.all([beagleThink(r.sfen, budget), sleep(delay)]);

  if (shouldResign(thought, r.ply)) {
    await resignGame(actor, id).catch(ignoreRace);
    return;
  }
  if (!thought.usi) return; // 合法手がない = 指し手の直後に詰みで終わっているはず
  await playMove(actor, id, { usi: thought.usi, expected_ply: r.ply, client_move_id: `beagle-${id}-${r.ply}` }).catch(ignoreRace);
}

/** 考えている間に対局が終わった・手数が進んだ（409）は何もしない。 */
function ignoreRace(e: unknown) {
  if (e instanceof ShogiError && e.status === 409) return;
  throw e;
}

/** テスト用: 考え中の手がすべて終わるまで待つ。 */
export async function beagleIdle(): Promise<void> {
  while (mem.inflight.size > 0) await Promise.allSettled([...mem.inflight]);
}

/** テスト用: 「考えている」間を固定する（null で元に戻す）。 */
export function _setBeagleDelayForTest(ms: number | null): void {
  mem.delayMs = ms;
}
