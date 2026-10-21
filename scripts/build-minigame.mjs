#!/usr/bin/env node
/* 🎮 締め切りダッシュを束ねる（scripts/build-shogi-board.mjs・build-shogi-beagle-worker.mjs と同じ考え方）。
 *   1. public/minigame/game.js        WebView・ブラウザ用（入口 src/lib/minigame/bridge.ts、iife）
 *   2. src/lib/minigame-sim-worker.generated.ts  サーバの検算 worker（入口 src/lib/minigame/sim-worker.ts、文字列）
 *   使い方: node scripts/build-minigame.mjs
 * ゲームのソース（ドット絵の sprites.generated.ts も含む）を変えたら作り直してコミットする。元のソースのハッシュを
 * 書き、src/lib/__tests__/minigame-build.test.ts がずれていないかを確かめる。
 * 束ねる道具は rolldown（vitest → vite が入れているもの。本番の依存には足さない）。 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const M = "src/lib/minigame/";
export const GAME_SOURCES = [
  `${M}sim.ts`,
  `${M}render.ts`,
  `${M}audio.ts`,
  `${M}game.ts`,
  `${M}host.ts`,
  `${M}bridge.ts`,
  `${M}types.ts`,
  `${M}sprites.ts`,
  `${M}sprites.placeholder.ts`,
  `${M}sprites.generated.ts`,
];
export const WORKER_SOURCES = [`${M}sim.ts`, `${M}sim-worker.ts`];

function hashOf(files) {
  const h = createHash("sha256");
  for (const f of files) {
    const p = path.join(root, f);
    h.update(f).update("\0").update(existsSync(p) ? readFileSync(p, "utf8") : "<missing>").update("\0");
  }
  return h.digest("hex").slice(0, 16);
}
export const gameSourceHash = () => hashOf(GAME_SOURCES);
export const workerSourceHash = () => hashOf(WORKER_SOURCES);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { build } = await import("rolldown");
  // 1. ゲーム（ブラウザ）
  {
    const res = await build({
      input: path.join(root, `${M}bridge.ts`),
      platform: "browser",
      write: false,
      output: { format: "iife", name: "BguruMinigame", minify: true, codeSplitting: false },
    });
    const chunk = res.output.find((o) => o.type === "chunk");
    if (!chunk) throw new Error("no output");
    const out = path.join(root, "public/minigame/game.js");
    const banner = `/* B-guru 🎮 締め切りダッシュ（bridge_version 1） source:${gameSourceHash()} — scripts/build-minigame.mjs で生成。手で直さない。 */\n`;
    writeFileSync(out, banner + chunk.code);
    console.log(`wrote ${path.relative(root, out)} (${(Buffer.byteLength(banner + chunk.code) / 1024).toFixed(1)} KB)`);
  }
  // 2. 検算 worker（Node）
  {
    const res = await build({
      input: path.join(root, `${M}sim-worker.ts`),
      platform: "node",
      write: false,
      external: ["node:worker_threads"],
      output: { format: "cjs", minify: true, codeSplitting: false },
    });
    const chunk = res.output.find((o) => o.type === "chunk");
    if (!chunk) throw new Error("no output");
    const out = path.join(root, "src/lib/minigame-sim-worker.generated.ts");
    const text =
      `/* 🎮 締め切りダッシュの検算 worker（scripts/build-minigame.mjs で生成。手で直さない）。 */\n` +
      `export const MINIGAME_WORKER_SOURCE_HASH = ${JSON.stringify(workerSourceHash())};\n` +
      `export const MINIGAME_WORKER_SRC = ${JSON.stringify(chunk.code)};\n`;
    writeFileSync(out, text);
    console.log(`wrote ${path.relative(root, out)} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
  }
}
