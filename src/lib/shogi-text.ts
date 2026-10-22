/* ☗ 将棋の文面（純関数）: チャットの対局中カードと、ビーグルの終局投稿。
 * AI は使わずテンプレートで作る（決め手の推定はしない）。口調は明るいビーグル犬「〜だわん」。 */
import { END_REASON_LABEL, type EndReason, type ShogiResult } from "./shogi-rules";
import type { ShogiMode } from "./shogi-clock";

export const MODE_LABEL: Record<ShogiMode, string> = { blitz: "⚡速い将棋", slow: "🐢ゆっくり将棋" };

type Names = { black: string; white: string };

/** 対局が始まったときのカード（文字だけでも通じる文。古いアプリは普通の発言として出す）。 */
export function cardStartText(n: Names, mode: ShogiMode): string {
  return `☗${n.black} vs ☖${n.white}（${MODE_LABEL[mode]}）対局中 → チャット上の「☗ 将棋」で観戦できます`;
}

export function resultPhrase(n: Names, result: ShogiResult | null, reason: EndReason | null, ply: number): string {
  if (reason === "aborted" || result == null) return "中断（勝敗なし）";
  const how = reason ? END_REASON_LABEL[reason] : "";
  if (result === "draw") return `引き分け（${how}・${ply} 手）`;
  const winner = result === "black" ? `☗${n.black}` : `☖${n.white}`;
  return `${winner} さんの勝ち（${how}・${ply} 手）`;
}

/** 終局したときにカードの本文を書き換える文。 */
export function cardEndText(n: Names, mode: ShogiMode, result: ShogiResult | null, reason: EndReason | null, ply: number): string {
  return `☗${n.black} vs ☖${n.white}（${MODE_LABEL[mode]}）終局: ${resultPhrase(n, result, reason, ply)}`;
}

const WIN_LINES = [
  "おめでとうだわん！見事な勝ちっぷりだったわん🐾",
  "おめでとうだわん！最後まで集中してたのが伝わってきたわん",
  "おめでとうだわん！しっぽがちぎれるくらい振っちゃうわん🐶",
  "おめでとうだわん！かっこよかったわん、ごほうびのおやつをあげたいわん🦴",
];
const LOSE_LINES = [
  "ナイスファイトだったわん！次はきっと勝てるわん",
  "おつかれさまだわん！いい勝負だったわん、また指してほしいわん",
  "惜しかったわん！感想戦でいっしょに振り返るわん",
  "最後まであきらめない姿、しっかり見てたわん！",
];

const REASON_NOTE: Partial<Record<EndReason, string>> = {
  resign: "潔い投了だったわん。",
  checkmate: "きれいに詰んだわん！",
  timeout: "時間切れで決着したわん⏱",
  perpetual_check: "連続王手の千日手は王手をかけ続けた側の負けだわん。",
  abandon: "72 時間指されなかったので放置で決着したわん。",
};

/** ビーグルがタイムラインに投稿する終局のまとめ（このスレッドが感想戦）。中断は投稿しない（null）。 */
export function beaglePostText(input: {
  gameId: number;
  names: Names;
  mode: ShogiMode;
  result: ShogiResult | null;
  reason: EndReason | null;
  ply: number;
  baseUrl: string;
  /** 実況の「分かれ目」の行（公開後だけ。なければ出さない）。 */
  turningPoints?: string[];
}): string | null {
  const { names, result, reason, ply, gameId } = input;
  if (result == null || reason === "aborted") return null;
  const base = input.baseUrl.replace(/\/+$/, "");
  const lines: string[] = [];
  lines.push("☗ 将棋の対局が終わったわん！🐶");
  lines.push("");
  lines.push(`☗先手 ${names.black} さん vs ☖後手 ${names.white} さん（${MODE_LABEL[input.mode]}）`);
  lines.push(`結果: ${resultPhrase(names, result, reason, ply)}`);
  const note = reason ? REASON_NOTE[reason] : undefined;
  if (note) lines.push(note);
  lines.push("");
  if (result === "draw") {
    lines.push(`${names.black} さん、${names.white} さん、ふたりとも譲らない名勝負だったわん！千日手は引き分けだわん。`);
  } else {
    const winner = result === "black" ? names.black : names.white;
    const loser = result === "black" ? names.white : names.black;
    lines.push(`${winner} さん、${WIN_LINES[gameId % WIN_LINES.length]}`);
    lines.push(`${loser} さん、${LOSE_LINES[gameId % LOSE_LINES.length]}`);
  }
  lines.push("");
  pushTurningPoints(lines, input.turningPoints);
  lines.push("このスレッドで感想戦をするわん。気になった局面をみんなで話すわん！");
  lines.push(`🎞 盤で再生: ${base}/#/shogi/${gameId}`);
  lines.push(`📄 棋譜（KIF）: ${base}/api/shogi/games/${gameId}/kif`);
  return lines.join("\n");
}

const BEAGLE_THANKS_WIN = [
  "負けちゃったわん…でも、すっごく楽しかったわん！強かったわん🐾",
  "まいったわん！ビーグルの読みを上回る見事な指し回しだったわん🐶",
  "やられたわん！最後まで攻めが鋭くて、しっぽを巻いちゃったわん",
];
const BEAGLE_THANKS_LOSE = [
  "今回はビーグルの勝ちだったけど、いい手がたくさんあったわん！",
  "最後まであきらめずに指してくれて、うれしかったわん🐾",
  "どんどん上手になってるわん！また練習しようわん",
];

/** ビーグル戦の終局投稿（勝っても負けても相手を褒める「対局ありがとうだわん」）。中断は投稿しない（null）。 */
export function beagleGamePostText(input: {
  gameId: number;
  names: Names;
  mode: ShogiMode;
  result: ShogiResult | null;
  reason: EndReason | null;
  ply: number;
  baseUrl: string;
  /** ビーグルの色。 */
  beagle: "black" | "white";
  /** 実況の「分かれ目」の行（公開後だけ。なければ出さない）。 */
  turningPoints?: string[];
}): string | null {
  const { names, result, reason, ply, gameId, beagle } = input;
  if (result == null || reason === "aborted") return null;
  const base = input.baseUrl.replace(/\/+$/, "");
  const human = beagle === "black" ? names.white : names.black;
  const lines: string[] = [];
  lines.push(`☗ 将棋 — ${human} さん、ビーグルと対局ありがとうだわん！🐶`);
  lines.push("");
  lines.push(`☗先手 ${names.black} さん vs ☖後手 ${names.white} さん（${MODE_LABEL[input.mode]}・練習）`);
  lines.push(`結果: ${resultPhrase(names, result, reason, ply)}`);
  lines.push("");
  if (result === "draw") lines.push(`千日手で引き分けだわん。${human} さん、ねばり強かったわん！`);
  else if (result === beagle) lines.push(`${human} さん、${BEAGLE_THANKS_LOSE[gameId % BEAGLE_THANKS_LOSE.length]}`);
  else lines.push(`${human} さん、${BEAGLE_THANKS_WIN[gameId % BEAGLE_THANKS_WIN.length]}`);
  if (input.turningPoints?.length) lines.push("");
  pushTurningPoints(lines, input.turningPoints);
  lines.push("いつでもまた相手になるわん。このスレッドで感想戦もできるわん！");
  lines.push(`🎞 盤で再生: ${base}/#/shogi/${gameId}`);
  lines.push(`📄 棋譜（KIF）: ${base}/api/shogi/games/${gameId}/kif`);
  return lines.join("\n");
}

/** 「分かれ目」（ビーグルの実況で評価が大きく動いた手。2〜3 手）。 */
function pushTurningPoints(lines: string[], points: string[] | undefined): void {
  if (!points || points.length === 0) return;
  lines.push("ビーグルが見た分かれ目だわん:");
  for (const p of points.slice(0, 3)) lines.push(p);
  lines.push("");
}
