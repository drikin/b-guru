/* ☗ ビーグルの実況 — 純関数（DB・ネットワークなし。docs/shogi-spec.md「ビーグルの実況」）。
 *
 *   - 事実（facts）: エンジンが出したものだけ。指し手の表記・駒取り・王手・評価値の変化・最善手・手数・持ち時間。
 *   - ひな形（templateText）: 事実だけから作るビーグルの 1〜2 文。AI がだめなときは必ずこれで埋める。
 *   - AI の文の検査（checkAiText）: 長すぎる・空・禁止語・事実にない手や数字・形勢や王手・詰み・駒取りの言い違いを落とす。
 *   - 見どころ（detectHighlight）とチャットの関所（highlightAllowed）: 1 局に途中の見どころ 2 件まで・数分あける
 *     （終局は既存の終局カード・ビーグルの投稿にまとめる → 合わせて 3 件まで）。1 手ずつは流さない。
 *   - 最新だけ（LatestOnly）: 同時に 1 つ。新しい依頼が来たら動いている古い方を打ち切り、待っている方も捨てる。 */
import { Position, standardPieceName } from "tsshogi";
import { labelFor, type Side } from "./shogi-rules";

/** 帯に出す文の上限（全角 60 字程度。数え方は文字数）。AI の文は名前を入れる前にこれで数える。 */
export const COMMENTARY_MAX_CHARS = 64;
/** AI の文に表示名を入れたあとの上限（名前は 8 字までに切るので、少しだけ伸びる）。 */
export const COMMENTARY_FINAL_MAX_CHARS = 76;
/** ビーグル（system アカウント）の表示名。 */
export const BEAGLE_NAME = "ビーグル";
/** 詰み筋を読んだときの評価（先手から見る。＋ = 先手勝ち）。 */
export const EVAL_MATE = 9999;
/** 評価の上限（帯の棒・保存の幅）。 */
export const EVAL_CLAMP = 5000;
/** 途中の見どころをチャットに出すのは 1 局 2 件まで（終局は既存のカード・投稿で 1 件 → 合わせて 3 件）。 */
export const MAX_MIDGAME_HIGHLIGHTS = 2;
/** 見どころと見どころの間（チャット）。 */
export const HIGHLIGHT_GAP_MS = 4 * 60_000;
/** 「形勢が傾いた」とみなす評価（歩 = 100）。 */
export const LEAN_CP = 300;
/** 形勢逆転: 片方に 400 以上だったのが、もう片方に 400 以上。 */
export const REVERSAL_CP = 400;

export type Highlight = "reversal" | "mate";

export type CommentaryFacts = {
  ply: number;
  /** 指した側。 */
  mover: Side;
  blackName: string;
  whiteName: string;
  /** 指し手の表記（例 "▲7六歩"）。 */
  moveLabel: string;
  /** 1 つ前の手の表記（相手の手。ビーグル戦で人の手に触れるため）。 */
  prevMoveLabel: string | null;
  /** 取った駒（例 "角"）。 */
  capture: string | null;
  /** 王手をかけた。 */
  check: boolean;
  /** 指す前・指した後の評価（先手から見る。歩 = 100、詰みは ±EVAL_MATE）。読めなかったら null。 */
  evalBefore: number | null;
  evalAfter: number | null;
  /** 1 つ前の局面でのビーグルの最善手（指した側にとって）。 */
  bestPrevLabel: string | null;
  /** 次の予想手（相手の番の最善手）。 */
  bestNextLabel: string | null;
  mode: "blitz" | "slow";
  /** 速い将棋の残り（ms）。 */
  clocks: { black_ms: number; white_ms: number } | null;
  /** 指し手で終局した（詰み・千日手など）。 */
  end?: { result: Side | "draw" | null; reason: string } | null;
};

// ─────────────────────────── 事実

/** 指す前の局面と指し手 → 取った駒・王手。指せない手なら null。 */
export function moveFacts(beforeSfen: string, usi: string): { capture: string | null; check: boolean; afterSfen: string } | null {
  const pos = Position.newBySFEN(beforeSfen);
  if (!pos) return null;
  const m = pos.createMoveByUSI(usi);
  if (!m) return null;
  const captured = usi.includes("*") ? null : pos.board.at(m.to);
  if (!pos.doMove(m)) return null;
  return { capture: captured ? standardPieceName(captured.type) : null, check: pos.checked, afterSfen: pos.sfen };
}

/** 局面の最善手（USI）→ 表記。直前の手（同〜の判定）を渡す。 */
export function bestLabel(sfen: string, usi: string | null, lastUsi: string | null): string | null {
  if (!usi) return null;
  const pos = Position.newBySFEN(sfen);
  if (!pos) return null;
  return labelFor(pos, usi, lastUsi);
}

/** エンジンの評価（手番側から見る）→ 先手から見た評価。±MATE 付近は詰み（±EVAL_MATE）。 */
export function evalForBlack(score: number, sideToMove: Side, mateBound: number): number {
  const s = sideToMove === "black" ? score : -score;
  if (s >= mateBound) return EVAL_MATE;
  if (s <= -mateBound) return -EVAL_MATE;
  return Math.max(-EVAL_CLAMP, Math.min(EVAL_CLAMP, Math.round(s)));
}

/** 詰み筋が見えている側（その側の勝ち筋）。 */
export function mateSide(ev: number | null): Side | null {
  if (ev == null) return null;
  if (ev >= EVAL_MATE) return "black";
  if (ev <= -EVAL_MATE) return "white";
  return null;
}

const sideMark = (s: Side) => (s === "black" ? "☗" : "☖");

/** 表示名を 8 字までに（ひな形と AI の文の差し替えで同じ切り方）。 */
export function shortName(n: string): string {
  const a = Array.from(n.trim() || "?");
  return a.length > 8 ? `${a.slice(0, 7).join("")}…` : a.join("");
}

/** 帯に出す呼び方（「☗ドリキンさん」、ビーグルは「☖ビーグル」）。 */
export function sideCall(side: Side, name: string): string {
  const n = shortName(name);
  return `${sideMark(side)}${n === BEAGLE_NAME ? n : `${n}さん`}`;
}

type Calls = { black: string; white: string };
/** 名前を出す呼び方（ひな形）。 */
const namedCalls = (names: { black: string; white: string }): Calls => ({ black: sideCall("black", names.black), white: sideCall("white", names.white) });
/** AI に渡す呼び方（名前は渡さない）。 */
const ANON: Calls = { black: "☗先手", white: "☖後手" };

/** 形勢の言葉（先手から見た評価）。calls = 呼び方（名前あり／先手・後手）。 */
export function trendWord(ev: number | null, names: { black: string; white: string }, calls: Calls = namedCalls(names)): string {
  if (ev == null) return "読み切れない";
  const m = mateSide(ev);
  if (m) return `${m === "black" ? calls.black : calls.white}の勝ち筋`;
  const a = Math.abs(ev);
  if (a < LEAN_CP) return "互角";
  const who = ev > 0 ? calls.black : calls.white;
  if (a < 800) return `${who}がやや有利`;
  if (a < 1500) return `${who}が有利`;
  return `${who}が優勢`;
}

/** 帯・チャットに出す見どころ。形勢逆転（片方に 400 以上 → もう片方に 400 以上）か、詰み筋が新しく見えた。 */
export function detectHighlight(before: number | null, after: number | null): Highlight | null {
  if (after == null) return null;
  const m = mateSide(after);
  if (m && mateSide(before) !== m) return "mate";
  if (before == null) return null;
  if ((before >= REVERSAL_CP && after <= -REVERSAL_CP) || (before <= -REVERSAL_CP && after >= REVERSAL_CP)) return "reversal";
  return null;
}

/** チャットに見どころを出してよいか（途中の見どころ 2 件まで・間を数分あける）。DB では同じ条件を 1 文の UPDATE で確かめる。 */
export function highlightAllowed(s: { count: number; lastAt: number | null; now: number }): boolean {
  if (s.count >= MAX_MIDGAME_HIGHLIGHTS) return false;
  return s.lastAt == null || s.now - s.lastAt >= HIGHLIGHT_GAP_MS;
}

// ─────────────────────────── ひな形（AI がだめなとき）

export const charLen = (s: string): number => Array.from(s).length;

function clip(s: string, max = COMMENTARY_MAX_CHARS): string {
  const a = Array.from(s);
  return a.length <= max ? s : `${a.slice(0, max - 1).join("")}…`;
}

/** 事実だけから作るビーグルの 1〜2 文（全角 60 字程度まで）。 */
export function templateText(f: CommentaryFacts): string {
  const names = { black: f.blackName, white: f.whiteName };
  const calls = namedCalls(names);
  const moverName = f.mover === "black" ? calls.black : calls.white;
  if (f.end) {
    if (f.end.reason === "checkmate" && f.end.result && f.end.result !== "draw") {
      return clip(`${f.moveLabel}で詰みだわん！${f.end.result === "black" ? calls.black : calls.white}の勝ちだわん🐾`);
    }
    if (f.end.result === "draw") return clip(`${f.moveLabel}で千日手、引き分けだわん。いい勝負だったわん`);
  }
  let first: string;
  if (f.capture && f.check) first = `${moverName}の${f.moveLabel}、${f.capture}を取って王手だわん！`;
  else if (f.check) first = `${moverName}の${f.moveLabel}、王手だわん！`;
  else if (f.capture) first = `${moverName}の${f.moveLabel}、${f.capture}を取ったわん。`;
  else first = `${moverName}の${f.moveLabel}だわん。`;

  const hl = detectHighlight(f.evalBefore, f.evalAfter);
  const m = mateSide(f.evalAfter);
  let second: string;
  if (m) second = `${sideMark(m)}側に詰み筋が見えるわん！`;
  else if (hl === "reversal") second = `形勢逆転、${trendWord(f.evalAfter, names)}だわん！`;
  else if (
    f.evalBefore != null &&
    f.evalAfter != null &&
    f.bestPrevLabel &&
    norm(f.bestPrevLabel) !== norm(f.moveLabel) &&
    (f.mover === "black" ? f.evalBefore - f.evalAfter : f.evalAfter - f.evalBefore) >= LEAN_CP
  ) {
    second = `ビーグルなら${f.bestPrevLabel}だったわん。`;
  } else if (f.bestNextLabel && f.ply % 3 === 0) second = `次は${f.bestNextLabel}が気になるわん。`;
  else second = `形勢は${trendWord(f.evalAfter, names)}だわん。`;
  const both = `${first}${second}`;
  if (charLen(both) <= COMMENTARY_MAX_CHARS) return both;
  return clip(first);
}

/** 終局（投了・時間切れ・放置）のひな形。 */
export function endTemplateText(input: { result: Side | "draw" | null; reason: string; ply: number; blackName: string; whiteName: string }): string {
  if (input.result == null || input.reason === "aborted") return "中断になったわん。またいつでも指してほしいわん";
  if (input.result === "draw") return clip(`まで ${input.ply} 手で引き分けだわん。ふたりともねばり強かったわん`);
  const winner = sideCall(input.result, input.result === "black" ? input.blackName : input.whiteName);
  const how: Record<string, string> = { resign: "投了", timeout: "時間切れ", abandon: "放置", perpetual_check: "連続王手の千日手", checkmate: "詰み" };
  return clip(`まで ${input.ply} 手、${how[input.reason] ?? "終局"}で${winner}の勝ちだわん！おつかれさまだわん🐾`);
}

// ─────────────────────────── AI（さくらの AI Engine）への依頼
// 対局者の表示名は AI に渡さない（名前に仕込まれた指示を読ませない）。AI には「☗先手」「☖後手」だけを渡し、
// 返ってきた文の「先手」「後手」を表示名に差し替える（personalize）。

export const AI_SYSTEM_PROMPT = [
  "あなたは将棋の対局を実況する明るいビーグル犬「ビーグル」です。口調は「〜だわん」。",
  "与えられた【事実】だけを使い、観戦している人向けに短い実況を 1〜2 文で書いてください。",
  "厳守: 全角 60 字以内。改行しない。【事実】にない指し手・駒・升目・数字を書かない。勝手に手を作らない。",
  "対局者は「先手」「後手」と呼ぶ（名前は書かない）。形勢は【事実】の「形勢」の言葉に合わせる。王手・駒取り・詰みは【事実】にあるときだけ書く。",
  "評価値の数字は書かない。悪口・下品な言葉・URL・絵文字以外の記号の飾りは使わない。実況の文だけを出力する。",
].join("\n");

export function aiUserPrompt(f: CommentaryFacts): string {
  const names = { black: f.blackName, white: f.whiteName };
  const beagle = f.blackName === BEAGLE_NAME ? "☗先手" : f.whiteName === BEAGLE_NAME ? "☖後手" : null;
  const lines = [
    "【事実】",
    `対局: ☗先手 vs ☖後手（${f.mode === "blitz" ? "速い将棋" : "ゆっくり将棋"}）${beagle ? `。${beagle}はビーグル（あなた）` : ""}`,
    `${f.ply} 手目: ${f.mover === "black" ? "☗先手" : "☖後手"}の ${f.moveLabel}`,
  ];
  if (f.prevMoveLabel) lines.push(`ひとつ前の手: ${f.prevMoveLabel}`);
  lines.push(`駒取り: ${f.capture ? `${f.capture}を取った` : "なし"}`);
  lines.push(`王手: ${f.check ? "あり" : "なし"}`);
  lines.push(`形勢: ${trendWord(f.evalAfter, names, ANON)}（指す前: ${trendWord(f.evalBefore, names, ANON)}）`);
  const m = mateSide(f.evalAfter);
  lines.push(`詰み筋: ${m ? `${m === "black" ? "☗先手" : "☖後手"}に見える` : "なし"}`);
  if (f.bestPrevLabel) lines.push(`ビーグルの読み（この手の前の最善手）: ${f.bestPrevLabel}`);
  if (f.bestNextLabel) lines.push(`次の予想手: ${f.bestNextLabel}`);
  if (f.clocks) lines.push(`残り時間: ☗${Math.floor(f.clocks.black_ms / 60000)} 分・☖${Math.floor(f.clocks.white_ms / 60000)} 分`);
  return lines.join("\n");
}

// ─────────────────────────── AI の文の検査

const FW_DIGIT = "０１２３４５６７８９";
const KANJI_RANK = "一二三四五六七八九";
const toAsciiDigits = (s: string) => s.replace(/[０-９]/g, (c) => String(FW_DIGIT.indexOf(c)));

/** 指し手の表記を比べられる形に（▲△☗☖・空白を除き、全角数字・段の漢数字を半角に、竜 → 龍）。 */
export function norm(label: string): string {
  return toAsciiDigits(label)
    .replace(/[▲△☗☖\s　]/g, "")
    .replace(/[一二三四五六七八九]/g, (c) => String(KANJI_RANK.indexOf(c) + 1))
    .replace(/竜/g, "龍");
}

const FORBIDDEN = [
  /https?:|www\.|@|<|>|```|＃|#/i,
  // 悪口・脅し（漢字・ひらがな・カタカナ）
  /死ね|しね[!！。、]?$|しねよ|シネ|殺|ころす|ころせ|コロス|ばか|バカ|馬鹿|アホ|あほ|阿呆|クソ|くそ|糞|ブス|ぶす|カス|かす[!！。]|ゴミ|ごみ[!！。]|クズ|くず|屑|うざ|ウザ|キモ|きも[いっ]|下手くそ|へたくそ|ヘタクソ|雑魚|ざこ|ザコ|無能|ぼけ|ボケ|間抜け|まぬけ|マヌケ|消えろ|きえろ/,
  // 差別語
  /ガイジ|がいじ|池沼|キチガイ|きちがい|気違い|基地外|めくら|つんぼ|かたわ|片輪|びっこ|部落|チョン|シナ人|土人|ホモ|オカマ|おかま|レズ/,
  /ソフト指し|カンニング|不正/,
  /評価値/,
  /[A-Za-z]{4,}/,
];

/** 形勢の言葉: 言っている側が良い（GOOD）・悪い（BAD）。 */
const GOOD = /(有利|優勢|優位|勝勢|必勝|リード|押して|押し気味|ペース|勝ち筋|勝ちそう|良さそう|よさそう)/;
const BAD = /(不利|劣勢|苦しい|苦し[くそ]|苦戦|負け|敗勢|ピンチ|厳しい|きびしい|追い込まれ)/;
const EVEN = /互角/;

export type AiCheck = { ok: true; text: string } | { ok: false; reason: string };

/** AI の文を検査する。だめならひな形に切り替える（呼び出し側）。 */
export function checkAiText(raw: string | null | undefined, f: CommentaryFacts): AiCheck {
  let t = (raw ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "");
  t = t.replace(/\r?\n+/g, "").trim();
  t = t.replace(/^(ビーグル|実況)\s*[:：]\s*/, "").trim();
  if (/^[「『"].*[」』"]$/.test(t)) t = t.slice(1, -1).trim();
  // gpt-oss の生の書式（analysis…assistantfinal…）が混じったら本文だけ。
  const fin = t.lastIndexOf("assistantfinal");
  if (fin >= 0) t = t.slice(fin + "assistantfinal".length).trim();
  if (!t) return { ok: false, reason: "empty" };
  if (charLen(t) > COMMENTARY_MAX_CHARS) return { ok: false, reason: "too_long" };
  const sentences = t.split(/[。！？!?]+/).filter((s) => s.replace(/[\s🐾🐶🦴✨…]/gu, "").length > 0);
  if (sentences.length > 2) return { ok: false, reason: "too_many_sentences" };
  for (const re of FORBIDDEN) if (re.test(t)) return { ok: false, reason: "forbidden" };
  if (!/わん/.test(t)) return { ok: false, reason: "tone" };

  // AI には名前を渡していない（文の中は「先手」「後手」だけ）。
  const body = t;

  // 指し手・升目: 事実の手（指した手・前の手・最善手・予想手）にあるものだけ。
  const allowed = [f.moveLabel, f.prevMoveLabel, f.bestPrevLabel, f.bestNextLabel].filter((x): x is string => !!x).map(norm);
  const ascii = toAsciiDigits(body);
  const SQ = /[1-9][一二三四五六七八九]|[1-9][1-9](?=成?[歩香桂銀金角飛玉王と馬龍竜])/g;
  const squares = ascii.match(SQ) ?? [];
  for (const sq of squares) {
    const n = norm(sq);
    if (!allowed.some((a) => a.includes(n))) return { ok: false, reason: "unknown_move" };
  }
  if (/同[\s　]*(歩|香|桂|銀|金|角|飛|玉|王|と|馬|龍|竜|成)/.test(body) && !allowed.some((a) => a.includes("同"))) {
    return { ok: false, reason: "unknown_move" };
  }

  // 数字: 手数・残り時間（分）だけ。升目は上で見たので除く。
  const numbersAllowed = new Set<string>([String(f.ply)]);
  if (f.clocks) {
    numbersAllowed.add(String(Math.floor(f.clocks.black_ms / 60000)));
    numbersAllowed.add(String(Math.floor(f.clocks.white_ms / 60000)));
  }
  const rest = ascii.replace(SQ, "〓");
  for (const num of rest.match(/\d+/g) ?? []) if (!numbersAllowed.has(String(Number(num)))) return { ok: false, reason: "unknown_number" };

  // 王手・詰み・駒取り: 事実にあるときだけ。
  if (/王手/.test(t) && !f.check) return { ok: false, reason: "false_check" };
  const mate = mateSide(f.evalAfter);
  const mateEnd = f.end?.reason === "checkmate";
  if (/詰|必至/.test(t) && !mate && !mateEnd) return { ok: false, reason: "false_mate" };
  const cap = t.match(/(歩|香|桂|銀|金|角|飛|と|馬|龍|竜|成香|成桂|成銀)を(取|と[っらりる])/);
  if (cap && (!f.capture || norm(f.capture) !== norm(cap[1]))) return { ok: false, reason: "false_capture" };
  if (!cap && /取っ|取り|取る|を取/.test(t.replace(/(先手|後手)を取/g, "")) && !f.capture) return { ok: false, reason: "false_capture" };

  // 形勢: 文ごとに「どちらの側が良い／悪いと言っているか」を見て、評価と逆なら落とす。
  const ev = f.evalAfter;
  if (ev != null) {
    const beagleSide = f.blackName === BEAGLE_NAME ? "black" : f.whiteName === BEAGLE_NAME ? "white" : null;
    for (const s of sentences) {
      if (EVEN.test(s) && Math.abs(ev) >= 800) return { ok: false, reason: "wrong_trend" };
      const good = GOOD.test(s);
      const bad = BAD.test(s);
      if (!good && !bad) continue;
      if (good && bad) continue; // 「先手有利、後手は苦しい」のような両方の言い方は側で決まらない（下で見る）
      let b = /先手|☗/.test(s);
      let w = /後手|☖/.test(s);
      if (/ビーグル|わたし|ぼく|ボク/.test(s.replace(/ビーグルなら|ビーグルの読み/g, ""))) {
        if (beagleSide === "black") b = true;
        if (beagleSide === "white") w = true;
      }
      if (b === w) continue; // どちらの話か分からない・両方
      // 良いと言っている側（悪いと言っていれば相手）
      const favored: Side = good === b ? "black" : "white";
      if (favored === "black" && ev <= -LEAN_CP) return { ok: false, reason: "wrong_trend" };
      if (favored === "white" && ev >= LEAN_CP) return { ok: false, reason: "wrong_trend" };
    }
  }
  const out = personalize(t, f);
  if (charLen(out) > COMMENTARY_FINAL_MAX_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true, text: out };
}

/** AI の文の「先手」「後手」（☗・さん付きも）を表示名の呼び方に差し替える（「☗ドリキンさん」、ビーグルは「ビーグル」）。 */
export function personalize(text: string, f: Pick<CommentaryFacts, "blackName" | "whiteName">): string {
  return text.replace(/[☗☖]?(先手|後手)(さん)?(?!を取|を引|に回|を踏)/g, (_m, who: string) => (who === "先手" ? sideCall("black", f.blackName) : sideCall("white", f.whiteName)));
}

// ─────────────────────────── 分かれ目（終局投稿）

export type CommentaryPoint = { ply: number; move_label: string; eval_cp: number | null };

/** 評価が大きく動いた手を 3 手まで（手数の順）。終局の投稿の「分かれ目」に使う。 */
export function turningPoints(rows: CommentaryPoint[], names: { black: string; white: string }, max = 3): string[] {
  const sorted = [...rows].sort((a, b) => a.ply - b.ply);
  const cand: { ply: number; label: string; delta: number; after: number }[] = [];
  let prev: number | null = 0; // 平手の初期局面は互角
  let prevPly = 0;
  for (const r of sorted) {
    if (r.eval_cp == null) {
      prev = null;
      continue;
    }
    // 抜けている手（最新だけ作るので飛ぶことがある）をまたいだ変化は、その手のせいとは言えないので数えない。
    if (prev != null && r.ply === prevPly + 1) {
      const clampEv = (x: number) => Math.max(-3000, Math.min(3000, x));
      const delta = Math.abs(clampEv(r.eval_cp) - clampEv(prev));
      if (delta >= 500) cand.push({ ply: r.ply, label: r.move_label, delta, after: r.eval_cp });
    }
    prev = r.eval_cp;
    prevPly = r.ply;
  }
  return cand
    .sort((a, b) => b.delta - a.delta)
    .slice(0, max)
    .sort((a, b) => a.ply - b.ply)
    .map((c) => `📍 ${c.ply} 手目 ${c.label}（形勢: ${trendWord(c.after, names)}）`);
}

// ─────────────────────────── 最新だけ（同時に 1 つ）

export type LatestJob = { gameId: number; ply: number };

/** 同時に 1 つだけ動かす（対局ごとに 1 つ持つ）。新しい依頼が来たら、動いている古い方は打ち切り（signal）、待っている方は捨てる。 */
export class LatestOnly<J extends LatestJob> {
  private running: { job: J; ctrl: AbortController; done: Promise<void> } | null = null;
  private queued: J | null = null;
  /** 捨てた・打ち切った数（テスト・ログ用）。 */
  dropped = 0;

  constructor(
    private run: (job: J, signal: AbortSignal) => Promise<void>,
    private onError: (e: unknown) => void = () => {},
    /** 動いている・待っている依頼がなくなったとき（対局ごとの入れ物を片付ける）。 */
    private onIdle: () => void = () => {}
  ) {}

  submit(job: J): void {
    if (this.queued) this.dropped++;
    this.queued = job;
    if (this.running) {
      if (!this.running.ctrl.signal.aborted) {
        this.running.ctrl.abort();
        this.dropped++;
      }
      return;
    }
    this.next();
  }

  private next(): void {
    const job = this.queued;
    this.queued = null;
    if (!job) {
      this.onIdle();
      return;
    }
    const ctrl = new AbortController();
    const done = Promise.resolve()
      .then(() => this.run(job, ctrl.signal))
      .catch((e) => {
        if (!ctrl.signal.aborted) this.onError(e);
      })
      .finally(() => {
        this.running = null;
        this.next();
      });
    this.running = { job, ctrl, done };
  }

  /** 動いている・待っている依頼（テスト用）。 */
  get busy(): boolean {
    return !!this.running || !!this.queued;
  }

  /** すべて終わるまで待つ（テスト用）。 */
  async idle(): Promise<void> {
    while (this.running) await this.running.done;
  }

  /** 対局の依頼を取り消す（終局で中断になったときなど）。 */
  cancel(gameId: number): void {
    if (this.queued?.gameId === gameId) {
      this.queued = null;
      this.dropped++;
    }
    if (this.running?.job.gameId === gameId && !this.running.ctrl.signal.aborted) {
      this.running.ctrl.abort();
      this.dropped++;
    }
  }
}

/** タイムアウトと打ち切りを 1 つの signal に。 */
export function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; dispose: () => void } {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal.aborted) ctrl.abort(signal.reason);
  else signal.addEventListener("abort", onAbort, { once: true });
  const t = setTimeout(() => ctrl.abort(new Error("timeout")), ms);
  (t as { unref?: () => void }).unref?.();
  return {
    signal: ctrl.signal,
    dispose: () => {
      clearTimeout(t);
      signal.removeEventListener("abort", onAbort);
    },
  };
}
