/* 🎮 締め切りダッシュの検算を動かす worker_threads の入口。scripts/build-minigame.mjs がこれと sim.ts を
 * 1 つの JS に束ね、src/lib/minigame-sim-worker.generated.ts（文字列）にする。サーバはその文字列を
 * `new Worker(src, { eval: true })` で動かす（Next の束ね方に左右されない。将棋のビーグルと同じ）。
 * 受け取る: { id, seed, character, inputs }、返す: { id, ok: true, result } か { id, ok: false, error }。 */
import { parentPort } from "node:worker_threads";
import { replay } from "./sim";

parentPort?.on("message", (msg: { id: number; seed: number; character: string; inputs: unknown }) => {
  try {
    const result = replay(msg.seed, msg.character, msg.inputs);
    parentPort?.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
});
