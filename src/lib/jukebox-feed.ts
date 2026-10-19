/* ジュークボックス: backspace.fm の過去回（Art19 の公開 RSS）を読む純粋な処理。
 * DB を触らないのでテストしやすい。取り込み・API・毎朝の投稿は lib/jukebox.ts。
 *
 * 音声 URL は RSS の enclosure をそのまま使う（podscribe → podtrac の計測付き）。
 * アプリで聴いてもダウンロード数に数えられるように（2026-10-19 ドリキン了承）。
 * 署名付きの CDN の URL は 24 時間で切れるので、保存しない。 */

export const ART19_FEED_URL = "https://rss.art19.com/backspace";

export type FeedEpisode = {
  guid: string;
  title: string;
  publishedAt: string; // ISO
  audioUrl: string;
  audioBytes: number;
  durationSec: number | null;
  /** Plain text, without the "このページをウェブブラウザで見る" boilerplate. */
  summary: string;
  series: string;
  number: number | null;
  /** The episode's page on backspace.fm, when the description links to it. */
  webUrl: string | null;
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function unwrap(s: string): string {
  const t = s.trim();
  const m = t.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  return m ? m[1] : decodeEntities(t);
}

function tag(item: string, name: string): string | null {
  const m = item.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m ? unwrap(m[1]) : null;
}

function attr(item: string, name: string, a: string): string | null {
  const m = item.match(new RegExp(`<${name}\\s[^>]*?${a}="([^"]*)"`));
  return m ? decodeEntities(m[1]) : null;
}

/** "02:04:10" / "1:05" / "3725" → seconds. */
export function parseDuration(s: string | null): number | null {
  if (!s) return null;
  const parts = s.trim().split(":").map((p) => parseInt(p, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0) || null;
}

/** Which programme: 本編, or one of the side series ("B-side", "DANBO-side", …). */
export function seriesOf(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("b-side")) return "B-side";
  if (t.includes("danbo")) return "DANBO-side";
  if (/techno?e?edge|テクノエッジ/.test(t)) return "TechnoEdge-side";
  if (t.includes("z-side")) return "Z-side";
  const m = title.match(/([A-Za-z]+)-side/);
  return m ? `${m[1]}-side` : "本編";
}

/** The episode number in the title ("#001: …", "… ep666", "BSM447"), or null. */
export function numberOf(title: string): number | null {
  const m = title.match(/#\s?(\d{1,4})/) || title.match(/\bep\s?(\d{1,4})\b/i) || title.match(/\bep(\d{1,4})/i);
  return m ? parseInt(m[1], 10) : null;
}

const BOILERPLATE = [
  /^このページをウェブブラウザで見る:\s*リンク\s*/,
  /^backspace\.fmは、1週間分のテック系トピックをまとめて紹介するポッドキャストです。[^。]*。(キャスターは[^。]*。)?\s*/,
];

/** The description as plain text (tags out, entities decoded, boilerplate off). */
export function summaryOf(html: string): string {
  let s = decodeEntities(html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, " "));
  s = s.replace(/[ \t　]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  for (const re of BOILERPLATE) s = s.replace(re, "");
  return s.trim();
}

export function webUrlOf(html: string): string | null {
  const m = html.match(/https:\/\/backspace\.fm\/episode\/[^"'\s<>]+/);
  return m ? m[0] : null;
}

/** All episodes in the feed, newest first. Items without audio are skipped. */
export function parseArt19(xml: string): FeedEpisode[] {
  const out: FeedEpisode[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const item = m[1];
    const guid = tag(item, "guid");
    const title = tag(item, "title");
    const audioUrl = attr(item, "enclosure", "url");
    const pub = tag(item, "pubDate");
    if (!guid || !title || !audioUrl || !/^https:\/\//.test(audioUrl) || !pub) continue;
    const date = new Date(pub);
    if (isNaN(date.getTime())) continue;
    const desc = tag(item, "description") ?? "";
    const t = title.trim();
    out.push({
      guid: guid.trim(),
      title: t,
      publishedAt: date.toISOString(),
      audioUrl,
      audioBytes: parseInt(attr(item, "enclosure", "length") ?? "0", 10) || 0,
      durationSec: parseDuration(tag(item, "itunes:duration")),
      summary: summaryOf(desc),
      series: seriesOf(t),
      number: numberOf(t),
      webUrl: webUrlOf(desc),
    });
  }
  return out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

// ── 毎朝の「N 年前の今日」 ─────────────────────────────────────────

/** Today's date in Japan as "YYYY-MM-DD". */
export function jstDay(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function jstMonthDay(iso: string): { y: number; md: number } {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return { y: d.getUTCFullYear(), md: (d.getUTCMonth() + 1) * 100 + d.getUTCDate() };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The episode for "N 年前の今日" on `day` (JST "YYYY-MM-DD"): one published on the
 *  same day in an earlier year — 本編 first — or else the nearest day within a
 *  week. The same day always gets the same pick. Null when nothing is close. */
export function pickForDay<E extends { guid: string; publishedAt: string; series: string }>(
  episodes: E[],
  day: string
): E | null {
  const [y, m, d] = day.split("-").map((n) => parseInt(n, 10));
  const base = Date.UTC(2001, m - 1, d); // any non-leap year: distances in days
  const dist = (e: E) => {
    const j = jstMonthDay(e.publishedAt);
    const other = Date.UTC(2001, Math.floor(j.md / 100) - 1, j.md % 100);
    const diff = Math.abs(other - base) / 86_400_000;
    return Math.min(diff, 365 - diff);
  };
  const past = episodes.filter((e) => jstMonthDay(e.publishedAt).y < y);
  for (let within = 0; within <= 7; within++) {
    const near = past.filter((e) => dist(e) <= within);
    if (!near.length) continue;
    const main = near.filter((e) => e.series === "本編");
    const pool = (main.length ? main : near).slice().sort((a, b) => a.guid.localeCompare(b.guid));
    return pool[hash(day) % pool.length];
  }
  return null;
}

export function yearsAgo(publishedAt: string, day: string): number {
  return parseInt(day.slice(0, 4), 10) - jstMonthDay(publishedAt).y;
}

export function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** The timeline post for the day's pick. The audio rides on the post (audio_url),
 *  so it plays right there; replies become that episode's thread. */
export function dailyPostText(
  e: { title: string; publishedAt: string; durationSec: number | null; summary: string; webUrl: string | null },
  day: string
): string {
  const n = yearsAgo(e.publishedAt, day);
  const sameDay = jstDay(new Date(e.publishedAt)).slice(5) === day.slice(5);
  const date = jstDay(new Date(e.publishedAt)).replaceAll("-", ".");
  const dur = formatDuration(e.durationSec);
  const summary = e.summary.replace(/\s+/g, " ").trim();
  const short = summary.length > 140 ? `${summary.slice(0, 140)}…` : summary;
  return [
    `📅 ${n} 年前の${sameDay ? "今日" : "今ごろ"}の backspace.fm`,
    "",
    `**${e.title}**`,
    `${date}${dur ? ` ・ ${dur}` : ""}`,
    ...(short ? ["", short] : []),
    "",
    "🎧 下の再生ボタンで聴けます。感想はこのスレッドへどうぞ",
    ...(e.webUrl ? [e.webUrl] : []),
  ].join("\n");
}
