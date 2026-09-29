/**
 * Date formatting with cached Intl.DateTimeFormat instances.
 *
 * `d.toLocaleString(locale, opts)` builds a brand-new Intl.DateTimeFormat on
 * every call, and that constructor is expensive (ICU / time-zone data). The
 * timeline formatted every post twice (JST + PDT) plus date keys/labels on each
 * render: a CPU profile of the logged-in first load (2026-09-28) put the JST/PDT
 * formatter alone at ~240ms of main-thread time, the top script hotspot.
 *
 * Per ECMA-402, toLocale{,Date,Time}String(locale, opts) === new
 * Intl.DateTimeFormat(locale, opts').format(d), where opts' only adds default
 * fields when none are given. Every formatter below either lists its fields
 * explicitly or relies on the same defaults, so output is byte-identical —
 * locked by date-format.test.ts against the toLocale* originals.
 */
const JST = "Asia/Tokyo";

const fJstFull = new Intl.DateTimeFormat("ja-JP", {
  timeZone: JST,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fPdt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const fJstMonthDay = new Intl.DateTimeFormat("ja-JP", { timeZone: JST, month: "numeric", day: "numeric" });
const fJstHm = new Intl.DateTimeFormat("en-GB", { timeZone: JST, hour: "2-digit", minute: "2-digit", hour12: false });
// toLocaleDateString with no date fields defaults to year/month/day "numeric".
const fJstDateKey = new Intl.DateTimeFormat("en-CA", { timeZone: JST, year: "numeric", month: "numeric", day: "numeric" });
const fUtcWeekday = new Intl.DateTimeFormat("ja-JP", { timeZone: "UTC", weekday: "short" });

/** "2026/9/28 18:40 JST / Sep 28, 02:40 PDT" style post timestamp. */
export function formatJSTPDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${fJstFull.format(d)} JST / ${fPdt.format(d)} PDT`;
}

/** Chat bubble timestamp (JST). Same local day → "HH:MM"; older → "M/D HH:MM".
 *  `now` is injectable for tests. */
export function chatTimeStr(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const md = (x: Date) => fJstMonthDay.format(x);
  const hm = fJstHm.format(d);
  return md(d) === md(now) ? hm : `${md(d)} ${hm}`;
}

/** YYYY-MM-DD in JST. */
export function jstDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return fJstDateKey.format(d);
}

/** "2026年8月8日 (土)" for a JST date key. */
export function jstDateLabel(dateKey: string): string {
  const [y, m, dd] = dateKey.split("-").map(Number);
  if (!y || !m || !dd) return dateKey;
  const wd = fUtcWeekday.format(new Date(Date.UTC(y, m - 1, dd)));
  return `${y}年${m}月${dd}日 (${wd})`;
}
