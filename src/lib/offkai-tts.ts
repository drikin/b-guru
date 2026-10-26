/* 🍻 オフ会: チャットの読み上げ（docs/offkai-spec.md「チャットの読み上げ」）。
 * 🍻 の音声に入っている（聞いている・話している）あいだ、届いたチャットの発言をブラウザの speechSynthesis で読む。
 * オンオフはこのブラウザだけ（localStorage、既定はオン）。サーバ・外部へは何も送らない。 */
import { getSnapshot as getOffkai, subscribe as subscribeOffkai } from "./offkai-client";

const LS_KEY = "bguru-offkai-tts";
/** 本文はここまで読んで「、以下略」。 */
export const MAX_CHARS = 80;
/** 届いてからこれより古くなったものは読まない（追いつけないとき古い話を延々読まない）。 */
export const STALE_MS = 2 * 60_000;

/** 読み上げる文（純粋。テスト済み）。 */
export function speechText(name: string | null | undefined, body: string | null | undefined, imageCount = 0): string | null {
  const who = (name ?? "").trim();
  let text = (body ?? "")
    .replace(/https?:\/\/[!-~]+/g, "リンク") // ASCII だけ（URL の直後の日本語まで「リンク」にしない。アプリと同じ）
    .replace(/\s+/g, " ")
    .trim();
  if (!text) {
    if (imageCount <= 0) return null;
    return who ? `${who}さんが写真を送りました` : "写真が送られました";
  }
  const chars = Array.from(text);
  if (chars.length > MAX_CHARS) text = chars.slice(0, MAX_CHARS).join("").trimEnd() + "、以下略";
  return who ? `${who}さん、${text}` : text;
}

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

/** 🍻 の音声に入っていて、オフ会が開いているか。 */
function active(): boolean {
  const s = getOffkai();
  return enabled && !!s.current && (s.audio === "listening" || s.audio === "speaking");
}

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
export function speakChat(msg: { id: number; authorName?: string | null; body?: string | null; images?: unknown[] | null }): void {
  if (!supported() || !active() || msg.id <= 0 || spoken.has(msg.id)) return;
  const text = speechText(msg.authorName, msg.body, msg.images?.length ?? 0);
  if (!text) return;
  spoken.add(msg.id);
  if (spoken.size > 500) spoken.delete(spoken.values().next().value as number);
  queue.push({ id: msg.id, text, at: Date.now() });
  next();
}

function stopAll(): void {
  queue.length = 0;
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
