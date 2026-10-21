#!/bin/sh
# ☗ 将棋の駒の字（public/shogi-board/fonts/shogi-piece.ttf）を作り直す。
#
#   元: Noto Serif JP（Google Fonts の公式配布物、可変フォント NotoSerifJP[wght].ttf、OFL 1.1）
#       https://fonts.google.com/noto/specimen/Noto+Serif+JP → Download family
#   道具: HarfBuzz の hb-subset（brew install harfbuzz）
#   使う字だけ（駒・成駒・段の漢数字）。太さは wght=600 に固定する。
#   2026-10-21 版: Version 2.003 から 26 字・約 9KB。ライセンスは同じフォルダの OFL.txt。
#
#   使い方: sh scripts/shogi-font-subset.sh /path/to/NotoSerifJP.ttf
set -eu
SRC="${1:?NotoSerifJP（可変）の .ttf を指定してください}"
OUT="$(cd "$(dirname "$0")/.." && pwd)/public/shogi-board/fonts/shogi-piece.ttf"
CHARS="王玉飛角金銀桂香歩龍竜馬全圭杏と成一二三四五六七八九"
TMP="$(mktemp)"
printf '%s' "$CHARS" > "$TMP"
LC_ALL=en_US.UTF-8 hb-subset --font-file="$SRC" --text-file="$TMP" --variations="wght=600" --output-file="$OUT"
rm -f "$TMP"
ls -l "$OUT"
