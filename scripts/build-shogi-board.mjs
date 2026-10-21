#!/usr/bin/env node
/* ☗ 将棋の盤面を WebView 用の 1 ファイル（public/shogi-board/board.js）に束ねる。
 *   入口: src/lib/shogi-board/bridge.ts（board.ts・shogi-rules.ts・tsshogi を含む）
 *   使い方: node scripts/build-shogi-board.mjs
 * 盤のソースを変えたら作り直してコミットする。束ねた中身の元（ソースのハッシュ）を 1 行目に書き、
 * src/lib/__tests__/shogi-board.test.ts がずれていないかを確かめる。
 * 束ねる道具は rolldown（vitest → vite が入れているもの。本番の依存には足さない）。 */
import { build } from "rolldown";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCES = ["src/lib/shogi-board/board.ts", "src/lib/shogi-board/bridge.ts", "src/lib/shogi-rules.ts", "package-lock.json"];

export function sourceHash() {
  const h = createHash("sha256");
  for (const f of SOURCES) {
    let text = readFileSync(path.join(root, f), "utf8");
    // package-lock は tsshogi の版だけを見る（ほかの依存の更新で作り直しを求めない）。
    if (f === "package-lock.json") text = JSON.stringify(JSON.parse(text).packages["node_modules/tsshogi"] ?? null);
    h.update(f).update("\0").update(text).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const out = path.join(root, "public/shogi-board/board.js");
  const res = await build({
    input: path.join(root, "src/lib/shogi-board/bridge.ts"),
    platform: "browser",
    write: false,
    output: { format: "iife", name: "BguruShogiBoard", minify: true, codeSplitting: false },
  });
  const chunk = res.output.find((o) => o.type === "chunk");
  if (!chunk) throw new Error("no output");
  const banner =
    `/* B-guru ☗ 将棋の盤（bridge_version 1） source:${sourceHash()} — scripts/build-shogi-board.mjs で生成。\n` +
    ` * Includes tsshogi 2.3.4 — Copyright (c) 2023 Kubo, Ryosuke — MIT License (/shogi-board/LICENSE-tsshogi.txt). */\n`;
  writeFileSync(out, banner + chunk.code);
  console.log(`wrote ${path.relative(root, out)} (${(Buffer.byteLength(banner + chunk.code) / 1024).toFixed(1)} KB)`);
}
