/**
 * lib/date-format.ts must be byte-identical to the toLocale* originals it
 * replaced (they are copied verbatim below as the oracle). Covers DST switches
 * (US), year boundaries, JST midnight edges and a dense sweep.
 */
import { describe, it, expect } from "vitest";
import { formatJSTPDT, chatTimeStr, jstDateKey, jstDateLabel } from "../date-format";

// ---- originals (verbatim from page.tsx / feed.ts before the change) ----
function oldFormatJSTPDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const pdt = d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${jst} JST / ${pdt} PDT`;
}
function oldChatTimeStr(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const md = (x: Date) => x.toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
  const hm = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
  return md(d) === md(now) ? hm : `${md(d)} ${hm}`;
}
function oldJstDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" });
}
function oldJstDateLabel(dateKey: string): string {
  const [y, m, dd] = dateKey.split("-").map(Number);
  if (!y || !m || !dd) return dateKey;
  const d = new Date(Date.UTC(y, m - 1, dd));
  const wd = d.toLocaleDateString("ja-JP", { timeZone: "UTC", weekday: "short" });
  return `${y}年${m}月${dd}日 (${wd})`;
}

const edges = [
  "2026-03-08T09:59:00Z", "2026-03-08T10:00:00Z", // US DST start
  "2026-11-01T08:59:00Z", "2026-11-01T09:00:00Z", // US DST end
  "2025-12-31T14:59:59Z", "2025-12-31T15:00:00Z", // JST new year
  "2026-09-28T14:59:00Z", "2026-09-28T15:00:00Z", // JST midnight
  "2026-02-28T23:30:00Z", "2028-02-29T03:00:00Z", // month end / leap day
  "2026-09-28T00:00:00.000+09:00",
];
const sweep: string[] = [];
for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2027, 0, 1); t += 37 * 3600_000 + 17 * 60_000) {
  sweep.push(new Date(t).toISOString());
}
const all = [...edges, ...sweep];

describe("date-format is byte-identical to the toLocale* originals", () => {
  it(`formatJSTPDT (${all.length} instants)`, () => {
    for (const iso of all) expect(formatJSTPDT(iso), iso).toBe(oldFormatJSTPDT(iso));
  });
  it("chatTimeStr, same-day and older", () => {
    for (const iso of all) {
      const d = new Date(iso);
      for (const now of [d, new Date(d.getTime() + 3600_000), new Date(d.getTime() + 30 * 3600_000)]) {
        expect(chatTimeStr(iso, now), iso).toBe(oldChatTimeStr(iso, now));
      }
    }
  });
  it("jstDateKey", () => {
    for (const iso of all) expect(jstDateKey(iso), iso).toBe(oldJstDateKey(iso));
  });
  it("jstDateLabel", () => {
    for (const iso of all) {
      const k = oldJstDateKey(iso);
      expect(jstDateLabel(k), k).toBe(oldJstDateLabel(k));
    }
  });
  it("invalid input behaves the same", () => {
    for (const bad of ["", "nope", "2026-13-45"]) {
      expect(formatJSTPDT(bad)).toBe(oldFormatJSTPDT(bad));
      expect(jstDateKey(bad)).toBe(oldJstDateKey(bad));
      expect(chatTimeStr(bad)).toBe("");
      expect(jstDateLabel(bad)).toBe(oldJstDateLabel(bad));
    }
  });
});

describe("date-format is actually faster (cached formatter)", () => {
  it("formats 2,000 timestamps several times faster than the original", () => {
    const xs = all.slice(0, 2000);
    const t0 = performance.now();
    for (const x of xs) oldFormatJSTPDT(x);
    const tOld = performance.now() - t0;
    const t1 = performance.now();
    for (const x of xs) formatJSTPDT(x);
    const tNew = performance.now() - t1;
    console.log(`formatJSTPDT x${xs.length}: old ${tOld.toFixed(1)}ms → new ${tNew.toFixed(1)}ms`);
    expect(tNew).toBeLessThan(tOld / 3);
  });
});
