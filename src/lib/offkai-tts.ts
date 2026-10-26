/* チャットの読み上げ（docs/offkai-spec.md「チャットの読み上げ」「チャット欄の読み上げ」「賢い読み方」）。
 * 🍻 の音声に入っている（聞いている・話している）あいだ（🍻 のトグル、既定オン）、またはチャット欄の「🔈 読み上げ」が
 * オンのあいだ（既定オフ）、届いたチャットの発言をブラウザの speechSynthesis で読む。オンオフはこのブラウザだけ。
 * サーバ・外部へは何も送らない（端末の中の声だけ）。 */
import { getSnapshot as getOffkai, subscribe as subscribeOffkai } from "./offkai-client";

const LS_KEY = "bguru-offkai-tts";
/** 本文はここまで読んで「、以下略」。 */
export const MAX_CHARS = 80;
/** 届いてからこれより古くなったものは読まない（追いつけないとき古い話を延々読まない）。 */
export const STALE_MS = 2 * 60_000;

/** 名前のあとに「さん」を付けないもの。 */
const HONORIFIC = /(さん|様|さま|氏|くん|君|ちゃん|先生)$/;
/** 呼び名（「さん」付き。純粋。Swift・Android と同じ決まり — docs/offkai-spec.md「賢い読み方」）。 */
export function callName(raw: string | null | undefined): string | null {
  const base = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!base) return null;
  // 1. 括弧の中を落とす  2. 先頭の @ を落として区切りで分ける  3. 文字か数字のある最初の部分
  const s = base
    .replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]|「[^」]*」|『[^』]*』|〔[^〕]*〕/g, " ")
    .replace(/^[\s@＠]+/, "");
  let name = s.split(/[\s　／/|｜・:：@＠～〜]+/).find((p) => /[\p{L}\p{N}]/u.test(p)) ?? "";
  // 4. 長ければ先頭 6 文字  5. 何も残らなければ元の名前の先頭 6 文字
  if (Array.from(name).length > 8) name = Array.from(name).slice(0, 6).join("");
  if (!name) name = Array.from(base).slice(0, 6).join("").trim();
  // 6. もう敬称で終わっていれば付けない
  return HONORIFIC.test(name) ? name : `${name}さん`;
}

/** 読み上げる文（純粋。テスト済み）。`sameAuthor`: 直前に読んだのと同じ人（名前を省く）。 */
export function speechText(
  name: string | null | undefined,
  body: string | null | undefined,
  imageCount = 0,
  sameAuthor = false
): string | null {
  const who = sameAuthor ? null : callName(name);
  let text = (body ?? "")
    .replace(/https?:\/\/[!-~]+/g, "リンク") // ASCII だけ（URL の直後の日本語まで「リンク」にしない。アプリと同じ）
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    if (imageCount <= 0) return null;
    if (sameAuthor) return "写真です";
    return who ? `${who}が写真を送りました` : "写真が送られました";
  }
  const chars = Array.from(text);
  if (chars.length > MAX_CHARS) text = chars.slice(0, MAX_CHARS).join("").trimEnd() + "、以下略";
  return who ? `${who}、${text}` : text;
}

/** 同じ人が続いたとみなす間隔。 */
export const SAME_AUTHOR_MS = 60_000;

// ---- オンオフ（このブラウザだけ） ----

let enabled = true;
try {
  enabled = localStorage.getItem(LS_KEY) !== "0";
} catch {
  /* 保存できない環境: 既定のオン */
}
const subs = new Set<() => void>();
export function ttsEnabled(): boolean {
  return enabled;
}
export function subscribeTts(l: () => void): () => void {
  subs.add(l);
  return () => subs.delete(l);
}
export function setTtsEnabled(on: boolean): void {
  enabled = on;
  try {
    localStorage.setItem(LS_KEY, on ? "1" : "0");
  } catch {
    /* 覚えられないだけ */
  }
  if (on) primeSpeech();
  else stopAll();
  for (const l of subs) l();
}

// チャット欄の「🔈 読み上げ」（🍻 に関係なく、いつでも。このブラウザだけ、既定はオフ）。
const LS_CHAT_KEY = "bguru-chat-tts";
let chatEnabled = false;
try {
  chatEnabled = localStorage.getItem(LS_CHAT_KEY) === "1";
} catch {
  /* 既定のオフ */
}
export function chatTtsEnabled(): boolean {
  return chatEnabled;
}
export function setChatTtsEnabled(on: boolean): void {
  chatEnabled = on;
  try {
    localStorage.setItem(LS_CHAT_KEY, on ? "1" : "0");
  } catch {
    /* 覚えられないだけ */
  }
  if (on) primeSpeech();
  else stopAll(); // 読んでいる途中も止める（🍻 を聞いていれば次の発言からまた読む）
  for (const l of subs) l();
}

// ---- 読む ----

type Item = { id: number; text: string; at: number };
const queue: Item[] = [];
const spoken = new Set<number>();
/** 読んでいる 1 件（参照を持っておく: Chrome は参照の切れた utterance の onend を落とすことがある）。 */
let current: SpeechSynthesisUtterance | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;

function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** 読むときか: チャット欄の読み上げがオン、または 🍻 の音声に入っていて 🍻 の読み上げがオン。 */
function active(): boolean {
  if (chatEnabled) return true;
  const s = getOffkai();
  return enabled && !!s.current && (s.audio === "listening" || s.audio === "speaking");
}

/** 直前に読む順に並べた発言の人と時刻（同じ人が続いたら名前を省く）。 */
let lastAuthor: { id: string; at: number } | null = null;

/** 端末の中の日本語の声だけ（ネットの声は文を外へ送るので使わない）。まだ一覧が取れていなければ null。 */
function japaneseVoice(): SpeechSynthesisVoice | null {
  const vs = window.speechSynthesis.getVoices();
  return vs.find((v) => v.lang === "ja-JP" && v.localService) ?? vs.find((v) => v.lang.startsWith("ja") && v.localService) ?? null;
}

let voicesWait = false;
function next(): void {
  if (current || !supported()) return;
  let item: Item | undefined;
  while ((item = queue.shift())) {
    if (Date.now() - item.at <= STALE_MS) break;
  }
  if (!item) return;
  if (!active()) {
    queue.length = 0;
    return;
  }
  const v = japaneseVoice();
  if (!v) {
    // 声の一覧がまだ（最初の一回）: 届くのを一度だけ待つ。届いても端末の日本語の声が無ければ読まない。
    queue.unshift(item);
    if (!voicesWait && window.speechSynthesis.getVoices().length === 0) {
      voicesWait = true;
      window.speechSynthesis.addEventListener("voiceschanged", () => next(), { once: true });
    } else {
      queue.length = 0;
    }
    return;
  }
  const u = new SpeechSynthesisUtterance(item.text);
  u.lang = "ja-JP";
  u.voice = v;
  current = u;
  const done = () => {
    if (current !== u) return; // 止めたあとに遅れて届いた古い知らせ
    current = null;
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    next();
  };
  u.onend = done;
  u.onerror = done;
  // 終わりの知らせが来ないことがある（ブラウザの不具合・音声の切り替え）: 長さから見積もった時間で次へ。
  watchdog = setTimeout(() => {
    if (current === u) window.speechSynthesis.cancel();
    done();
  }, Array.from(item.text).length * 200 + 5000);
  window.speechSynthesis.speak(u);
}

/** ボタンを押したその場で一度鳴らしておく（Safari などは、操作の中で一度 speak しないと後から鳴らない）。 */
export function primeSpeech(): void {
  if (!supported() || current) return;
  try {
    const u = new SpeechSynthesisUtterance("");
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch {
    /* 鳴らせない環境 */
  }
}

/** チャットに新しい発言が届いた（呼ぶ側で自分の発言・お知らせ・☗ カードは除く）。 */
export function speakChat(msg: {
  id: number;
  authorId?: string | null;
  authorName?: string | null;
  body?: string | null;
  images?: unknown[] | null;
}): void {
  if (!supported() || !active() || msg.id <= 0 || spoken.has(msg.id)) return;
  const now = Date.now();
  const same = !!msg.authorId && lastAuthor?.id === msg.authorId && now - lastAuthor.at <= SAME_AUTHOR_MS;
  const text = speechText(msg.authorName, msg.body, msg.images?.length ?? 0, same);
  if (!text) return;
  if (msg.authorId) lastAuthor = { id: msg.authorId, at: now };
  spoken.add(msg.id);
  if (spoken.size > 500) spoken.delete(spoken.values().next().value as number);
  queue.push({ id: msg.id, text, at: Date.now() });
  next();
}

function stopAll(): void {
  queue.length = 0;
  lastAuthor = null; // 次に読むときは名前から
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  const was = current;
  current = null; // 先に外す（cancel のあと遅れて届く onerror を無視する）
  if (supported() && was) window.speechSynthesis.cancel();
}

// 🍻 の音声から出た・オフ会が終わったら、読んでいる途中も止めて待ちも捨てる。
if (typeof window !== "undefined") {
  subscribeOffkai(() => {
    if (!active() && (current || queue.length > 0)) stopAll();
  });
}
