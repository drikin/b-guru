/* 📝 ネタ帳の型と表示の小物（DB を使わない。画面の部品からも読める）。 */

export type NetaWeek = {
  id: number;
  title: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  liveRecordingDate: string | null;
  liveUrl: string | null;
};

export type NetaTopic = {
  id: number;
  weekId: number;
  title: string;
  url: string;
  description: string | null;
  submitter: string;
  featured: boolean;
  /** 聞きたい = 移行前の票 + 新しい票。 */
  stars: number;
  comments: number;
  createdAt: string;
};

export type NetaComment = { id: number; commenter: string; body: string; createdAt: string };

export type NetaSort = "stars" | "new";

export const NETA_DESCRIPTION_PREVIEW = 140;

/** 一覧に出す説明の冒頭（空白をまとめて切る）。 */
export function netaPreview(text: string | null, max = NETA_DESCRIPTION_PREVIEW): string {
  const s = (text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") + "…" : s;
}

/** 記事のサイト名（ホスト。www. は外す）。読めない URL は空。 */
export function netaHost(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 外へのリンクにしてよい URL（http(s) だけ）。それ以外は null（javascript: などを出さない）。 */
export function netaSafeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 日本時間で「2026/11/09 04:40」。 */
export function netaDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("year")}/${g("month")}/${g("day")} ${g("hour")}:${g("minute")}`;
}

/** ライブ収録日（ネタ帳の入力欄のまま「2026-09-13T13:00」で入っている）を「2026/09/13 13:00」に。ほかの形はそのまま。 */
export function netaLiveDate(raw: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(raw.trim());
  if (!m) return raw.trim();
  return `${m[1]}/${m[2]}/${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}

/** ?sort= の読み取り（知らない値は聞きたい順）。 */
export function netaSort(v: string | string[] | undefined): NetaSort {
  return (Array.isArray(v) ? v[0] : v) === "new" ? "new" : "stars";
}
