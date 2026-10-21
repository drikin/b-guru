#!/usr/bin/env node
/* ☗ ビーグルの探索 worker を 1 つの JS に束ね、文字列として src/lib/shogi-beagle-worker.generated.ts に書く。
 *   入口: src/lib/shogi-beagle-worker.ts（shogi-engine.ts を含む。tsshogi は使わない）
 *   使い方: node scripts/build-shogi-beagle-worker.mjs
 * 探索のソースを変えたら作り直す。元のソースのハッシュを書き、src/lib/__tests__/shogi-beagle.test.ts がずれを検出する。
 * 束ねる道具は rolldown（build-shogi-board.mjs と同じ。本番の依存には足さない）。 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES = ["src/lib/shogi-engine.ts", "src/lib/shogi-beagle-worker.ts"];

export function sourceHash() {
  const h = createHash("sha256");
  for (const f of SOURCES) h.update(f).update("\0").update(readFileSync(path.join(root, f), "utf8")).update("\0");
  return h.digest("hex").slice(0, 16);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { build } = await import("rolldown");
  const res = await build({
    input: path.join(root, "src/lib/shogi-beagle-worker.ts"),
    platform: "node",
    write: false,
    external: ["node:worker_threads"],
    output: { format: "cjs", minify: true, codeSplitting: false },
  });
  const chunk = res.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("no output");
  const out = path.join(root, "src/lib/shogi-beagle-worker.generated.ts");
  const text =
    `/* ☗ ビーグルの探索 worker（scripts/build-shogi-beagle-worker.mjs で生成。手で直さない）。 */\n` +
    `export const BEAGLE_WORKER_SOURCE_HASH = ${JSON.stringify(sourceHash())};\n` +
    `export const BEAGLE_WORKER_SRC = ${JSON.stringify(chunk.code)};\n`;
  writeFileSync(out, text);
  console.log(`wrote ${path.relative(root, out)} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
}
