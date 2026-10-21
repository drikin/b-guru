/* 🎮 締め切りダッシュの検算: 操作の記録を同じシミュレーション（minigame/sim.ts）で再生してスコアを決める。
 *
 * 別スレッド（worker_threads）に 1 つだけ作り、順番待ちで 1 件ずつ。1 件 2 秒まで（正直な 4 分の記録で数 ms）。
 * worker は scripts/build-minigame.mjs が束ねた文字列（minigame-sim-worker.generated.ts）から作る
 * （将棋のビーグルと同じ。Next の束ね方に左右されない）。上限を超えた worker は捨てて作り直す。
 * テスト（vitest）と MINIGAME_VERIFY_INLINE=1 は worker を使わずその場で再生する。 */
import { Worker } from "node:worker_threads";
import { replay, type ReplayResult } from "./minigame/sim";
import { MINIGAME_WORKER_SRC } from "./minigame-sim-worker.generated";

export const VERIFY_TIMEOUT_MS = 2000;

type Job = { seed: number; character: string; inputs: unknown; resolve: (r: ReplayResult) => void; reject: (e: Error) => void };
type State = { worker: Worker | null; seq: number; queue: Job[]; busy: boolean };
const g0 = globalThis as unknown as { __bguruMinigameVerify?: State };
const st: State = (g0.__bguruMinigameVerify ??= { worker: null, seq: 0, queue: [], busy: false });

function inlineMode(): boolean {
  return process.env.MINIGAME_VERIFY_INLINE === "1" || (!!process.env.VITEST && process.env.MINIGAME_VERIFY_WORKER !== "1");
}

export class VerifyTimeout extends Error {}

function getWorker(): Worker {
  if (st.worker) return st.worker;
  const w = new Worker(MINIGAME_WORKER_SRC, { eval: true, resourceLimits: { maxOldGenerationSizeMb: 64 } });
  w.unref();
  w.on("error", () => {
    if (st.worker === w) st.worker = null;
  });
  w.on("exit", () => {
    if (st.worker === w) st.worker = null;
  });
  st.worker = w;
  return w;
}

function runOne(job: Job): Promise<void> {
  return new Promise((done) => {
    let w: Worker;
    try {
      w = getWorker();
    } catch (e) {
      job.reject(e as Error);
      done();
      return;
    }
    const id = ++st.seq;
    let settled = false;
    const finish = () => {
      settled = true;
      clearTimeout(timer);
      w.off("message", onMsg);
      w.off("exit", onExit);
      done();
    };
    const onMsg = (m: { id: number; ok: boolean; result?: ReplayResult; error?: string }) => {
      if (m.id !== id || settled) return;
      finish();
      if (m.ok && m.result) job.resolve(m.result);
      else job.reject(new Error(m.error ?? "verify error"));
    };
    const onExit = () => {
      if (settled) return;
      finish();
      job.reject(new Error("verify worker exit"));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      finish();
      if (st.worker === w) st.worker = null;
      void w.terminate().catch(() => {});
      job.reject(new VerifyTimeout("verify timeout"));
    }, VERIFY_TIMEOUT_MS);
    timer.unref?.();
    w.on("message", onMsg);
    w.on("exit", onExit);
    w.postMessage({ id, seed: job.seed, character: job.character, inputs: job.inputs });
  });
}

async function pump(): Promise<void> {
  if (st.busy) return;
  st.busy = true;
  try {
    while (st.queue.length) {
      const job = st.queue.shift()!;
      await runOne(job);
    }
  } finally {
    st.busy = false;
  }
}

/** 記録を再生する（順番待ち・1 件 2 秒まで）。 */
export function verifyReplay(seed: number, character: string, inputs: unknown, opts: { inline?: boolean } = {}): Promise<ReplayResult> {
  if (opts.inline ?? inlineMode()) return Promise.resolve(replay(seed, character, inputs));
  return new Promise((resolve, reject) => {
    st.queue.push({ seed, character, inputs, resolve, reject });
    void pump();
  });
}

/** テスト用: worker を止める。 */
export async function _stopVerifyWorker(): Promise<void> {
  const w = st.worker;
  st.worker = null;
  if (w) await w.terminate().catch(() => {});
}
