/* 🐶 ビーグルのリマインドの決まり（docs/beagle-reminders-spec.md）。DB も AI も使わない純粋な関数だけ:
 *  - 日本時間の計算（JST は夏時間なしの +9 固定）
 *  - 繰り返しの次の回
 *  - 「@ビーグル」の発言がリマインドの依頼らしいか・一覧・取り消し
 *  - 「N 分後」だけの短いタイマー（AI を通さず読む）
 *  - AI が返した JSON の確かめ（形・範囲） */

const JST_MS = 9 * 3600_000;
export const MIN_LEAD_MS = 10_000;
export const MAX_LEAD_MS = 366 * 24 * 3600_000;
export const MAX_TIMER_MS = 24 * 3600_000;
export const TEXT_MAX = 100;
/** 全員向けが鳴ってよい日本時間（7:00〜23:59）。 */
export const EVERYONE_HOURS = { from: 7, to: 24 };
const WD = ["日", "月", "火", "水", "木", "金", "土"];

export type Jst = { y: number; mo: number; d: number; h: number; mi: number; wd: number };

export function jst(t: Date | number): Jst {
  const x = new Date(+t + JST_MS);
  return { y: x.getUTCFullYear(), mo: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes(), wd: x.getUTCDay() };
}

export function fromJst(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi) - JST_MS);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** 「10/27（火）21:00」。同じ年でなければ年も。 */
export function jstLabel(t: Date, now: Date = new Date()): string {
  const j = jst(t);
  const year = jst(now).y === j.y ? "" : `${j.y}/`;
  return `${year}${j.mo}/${j.d}（${WD[j.wd]}）${j.h}:${pad(j.mi)}`;
}

// ---- 繰り返し ----

export type RepeatRule = { freq: "daily" | "weekdays" | "weekly" | "monthly"; time: string; weekdays?: number[]; day?: number };

export function validRepeat(v: unknown): RepeatRule | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const freq = r.freq;
  if (freq !== "daily" && freq !== "weekdays" && freq !== "weekly" && freq !== "monthly") return null;
  if (typeof r.time !== "string" || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(r.time)) return null;
  const time = r.time.padStart(5, "0");
  if (freq === "weekly") {
    const wds = Array.isArray(r.weekdays) ? [...new Set(r.weekdays.filter((x): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 6))].sort() : [];
    if (wds.length === 0) return null;
    return { freq, time, weekdays: wds };
  }
  if (freq === "monthly") {
    const day = Number(r.day);
    if (!Number.isInteger(day) || day < 1 || day > 31) return null;
    return { freq, time, day };
  }
  return { freq, time };
}

/** `after` より後の最初の回。 */
export function nextRepeat(rule: RepeatRule, after: Date): Date {
  const [h, mi] = rule.time.split(":").map(Number);
  const start = jst(after);
  for (let i = 0; i < 400; i++) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + i));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const wd = day.getUTCDay();
    const ok =
      rule.freq === "daily" ||
      (rule.freq === "weekdays" && wd >= 1 && wd <= 5) ||
      (rule.freq === "weekly" && (rule.weekdays ?? []).includes(wd)) ||
      (rule.freq === "monthly" && d === Math.min(rule.day ?? 1, new Date(Date.UTC(y, mo, 0)).getUTCDate()));
    if (!ok) continue;
    const t = fromJst(y, mo, d, h, mi);
    if (t > after) return t;
  }
  throw new Error("no next occurrence");
}

export function repeatLabel(rule: RepeatRule): string {
  if (rule.freq === "daily") return `毎日 ${rule.time}`;
  if (rule.freq === "weekdays") return `平日 ${rule.time}`;
  if (rule.freq === "monthly") return `毎月 ${rule.day} 日 ${rule.time}`;
  return `毎週${(rule.weekdays ?? []).map((w) => WD[w]).join("・")}曜 ${rule.time}`;
}

// ---- 依頼の判定 ----

const strip = (body: string) => body.replace(/@ビーグル(?![\p{L}\p{N}])/gu, " ").replace(/\s+/g, " ").trim();
const TIME_WORD = /\d+\s*(秒|分|時間)\s*(後|経|た|で)|\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*時(?!間)|明日|明後日|あさって|今夜|今晩|今日|来週|\d{1,2}\s*[\/／]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日|[月火水木金土日]曜/;
const ASK_WORD = /知らせ|教え|起こし|言って|呼んで|通知|リマインド/;

/** リマインドの依頼らしいか（AI に読ませる前のふるい。外れたらふつうの答えに回る）。 */
export function looksLikeReminder(body: string): boolean {
  const t = strip(body);
  if (/リマインド|リマインダー|タイマー|アラーム/.test(t)) return true;
  if (TIME_WORD.test(t) && ASK_WORD.test(t)) return true;
  if (/毎(日|週|朝|晩|月)|平日/.test(t) && ASK_WORD.test(t)) return true;
  return false;
}

/** 「リマインド一覧」。 */
export function isListCommand(body: string): boolean {
  return /(リマインド|リマインダー|タイマー|予定|お知らせ)\s*の?\s*(一覧|リスト)/.test(strip(body));
}

/** 「リマインド取り消し 12 13」「リマインド全部取り消し」→ 番号（all: 全部）。違えば null。 */
export function parseCancel(body: string): { all: boolean; ids: number[] } | null {
  const t = strip(body);
  // 「投稿を削除するには」で予定が消えないよう、リマインドの言葉があるときだけ（security-reviewer 2026-10-27）。
  if (!/(取り消|取消|キャンセル|削除)/.test(t) || !/(リマインド|リマインダー|タイマー|予定|お知らせ)/.test(t)) return null;
  const all = /(全部|すべて|全て|ぜんぶ)/.test(t);
  const ids = [...t.matchAll(/\d+/g)].map((m) => Number(m[0])).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!all && ids.length === 0) return null;
  return { all, ids: [...new Set(ids)].slice(0, 20) };
}

/** 「N 分後」「25 分タイマー」だけの短いタイマー（日時・繰り返し・みんなに、を含まないもの）→ 秒と文。 */
export function parseQuickTimer(body: string): { ms: number; text: string } | null {
  const t = strip(body);
  if (/みんな|全員|チャットで|毎|明日|明後日|今日|今夜|今晩|曜|[:：]|\d\s*時(?!間)|\d\s*[\/／]\s*\d|\d\s*月/.test(t)) return null;
  if (!/(後|タイマー|経ったら|たったら)/.test(t)) return null;
  const re = /(\d+)\s*(時間|分|秒)/g;
  let ms = 0;
  let n = 0;
  for (const m of t.matchAll(re)) {
    ms += Number(m[1]) * (m[2] === "時間" ? 3600_000 : m[2] === "分" ? 60_000 : 1000);
    n++;
  }
  if (n === 0 || ms < MIN_LEAD_MS || ms > MAX_TIMER_MS) return null;
  const text = t
    .replace(/((\d+)\s*(時間|分|秒)\s*)+(後|経ったら|たったら)?\s*(に|で)?/g, " ")
    .replace(/タイマー\s*(を)?\s*(セット|かけ)?\s*(して)?\s*(ね|ください|下さい)?/g, " ")
    .replace(/(を|って|と)?\s*(教えて|知らせて|リマインドして|リマインド|呼んで|言って|起こして)\s*(ね|ください|下さい|ほしい|欲しい|くれる|くれ)?\s*[?？]?/g, " ")
    .replace(/(お願い(します)?|よろしく)/g, " ")
    .replace(/[。、！!\s]+/g, " ")
    .trim();
  return { ms, text: cleanText(text) };
}

/** 鳴らすときの文: URL を外し、@ を全角に（誰も呼ばない）、改行をまとめ、100 文字まで。 */
export function cleanText(v: unknown): string {
  if (typeof v !== "string") return "";
  return [...v.replace(/(https?:\/\/|www\.)\S+/gi, "").replace(/@/g, "＠").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()]
    .slice(0, TEXT_MAX)
    .join("");
}

// ---- AI の答えの確かめ ----

export type Plan =
  | { kind: "timer" | "at"; audience: "me" | "everyone"; text: string; fires: Date[] }
  | { kind: "event"; audience: "me" | "everyone"; text: string; fires: Date[]; eventAt: Date }
  | { kind: "repeat"; audience: "me" | "everyone"; text: string; repeat: RepeatRule; fires: Date[] };

/** 「YYYY-MM-DDTHH:mm」（日本時間）→ 時刻。 */
export function parseJstLocal(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const t = fromJst(y, mo, d, h, mi);
  return jst(t).d === d ? t : null; // 2/30 など
}

function everyoneHourOk(t: Date): boolean {
  const h = jst(t).h;
  return h >= EVERYONE_HOURS.from && h < EVERYONE_HOURS.to;
}

/** AI の JSON → 作る予定（または断る理由）。 */
export function planFromAi(raw: unknown, now: Date): { plan: Plan } | { error: string } | { none: true } {
  if (!raw || typeof raw !== "object") return { error: "うまく読み取れなかったわん" };
  const o = raw as Record<string, unknown>;
  if (o.action === "none") return { none: true };
  if (o.action !== "create") return { error: "うまく読み取れなかったわん" };
  const audience = o.audience === "everyone" ? "everyone" : "me";
  const text = cleanText(o.text);
  const ahead = (t: Date) => t.getTime() - now.getTime() >= MIN_LEAD_MS && t.getTime() - now.getTime() <= MAX_LEAD_MS;
  const quiet = "みんなへのお知らせは 7 時〜24 時のあいだだけだわん";
  if (o.kind === "timer") {
    const sec = Number(o.after_seconds);
    if (!Number.isFinite(sec) || sec * 1000 < MIN_LEAD_MS || sec * 1000 > MAX_TIMER_MS) return { error: "タイマーは 10 秒〜24 時間だわん" };
    const t = new Date(now.getTime() + Math.round(sec) * 1000);
    if (audience === "everyone" && !everyoneHourOk(t)) return { error: quiet };
    return { plan: { kind: "timer", audience, text, fires: [t] } };
  }
  if (o.kind === "at") {
    const t = parseJstLocal(o.at);
    if (!t) return { error: "いつか読み取れなかったわん。「明日 9 時」のように書いてほしいわん" };
    if (!ahead(t)) return { error: t <= now ? "その時刻はもう過ぎているわん" : "1 年より先は覚えていられないわん" };
    if (audience === "everyone" && !everyoneHourOk(t)) return { error: quiet };
    return { plan: { kind: "at", audience, text, fires: [t] } };
  }
  if (o.kind === "repeat") {
    const rule = validRepeat(o.repeat);
    if (!rule) return { error: "繰り返しは毎日・平日・毎週（曜日）・毎月（日にち）で、時刻つきだわん" };
    if (audience === "everyone") {
      const h = Number(rule.time.slice(0, 2));
      if (h < EVERYONE_HOURS.from) return { error: quiet };
    }
    return { plan: { kind: "repeat", audience, text, repeat: rule, fires: [nextRepeat(rule, now)] } };
  }
  if (o.kind === "event") {
    const at = parseJstLocal(o.at);
    if (!at || at <= now) return { error: "予定の日時が読み取れなかったわん" };
    const before = Array.isArray(o.before_minutes) ? o.before_minutes.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 30 * 24 * 60) : [];
    const fires = [...new Set(before.length ? before : [0])]
      .map((m) => new Date(at.getTime() - m * 60_000))
      .filter((t) => ahead(t))
      .sort((a, b) => +a - +b)
      .slice(0, 5);
    if (fires.length === 0) return { error: "お知らせする時刻がもう過ぎているわん" };
    if (audience === "everyone" && !fires.every(everyoneHourOk)) return { error: quiet };
    return { plan: { kind: "event", audience, text, fires, eventAt: at } };
  }
  return { error: "うまく読み取れなかったわん" };
}

/** 予定の何分前か（「1 時間後に」「明日」）。 */
export function beforeLabel(fire: Date, eventAt: Date): string {
  const m = Math.round((eventAt.getTime() - fire.getTime()) / 60_000);
  if (m <= 0) return "今から";
  if (m % (24 * 60) === 0) return m === 24 * 60 ? "明日" : `${m / (24 * 60)} 日後に`;
  if (m % 60 === 0) return `${m / 60} 時間後に`;
  return `${m} 分後に`;
}
