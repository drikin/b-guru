/* ☗ ビーグルの探索を動かす worker_threads の入口。scripts/build-shogi-beagle-worker.mjs が
 * これと shogi-engine.ts を 1 つの JS に束ね、shogi-beagle-worker.generated.ts（文字列）にする。
 * サーバはその文字列を `new Worker(src, { eval: true })` で動かす（Next の束ね方に左右されない）。
 * 受け取る: { id, sfen, opts }、返す: { id, ok: true, result } か { id, ok: false, error }。 */
import { parentPort } from "node:worker_threads";
import { beagleSearch, type BeagleSearchOptions } from "./shogi-engine";

parentPort?.on("message", (msg: { id: number; sfen: string; opts: BeagleSearchOptions }) => {
  try {
    const result = beagleSearch(msg.sfen, msg.opts);
    parentPort?.postMessage({ id: msg.id, ok: true, result });
  } catch (e) {
    parentPort?.postMessage({ id: msg.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
});
