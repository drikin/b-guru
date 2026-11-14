/* 📝 ネタ帳の読み出し（docs/neta-integration-plan.md、第 1 段階: 誰でも読める公開ページ）。
 * neta.backspace.fm（Netaspace）から写した neta_ 表を読む。書き込み（投稿・聞きたい・コメント）は第 2 段階。
 * 公開ページで使うので、B-guru の会員の情報（投稿・名前・人数）はここでは一切読まない。 */
import { pool } from "./db";

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

export const NETA_LIST_LIMIT = 300;
export const NETA_DESCRIPTION_PREVIEW = 140;

const WEEK_COLS = `id, title, start_date, end_date, is_active, live_recording_date, live_url`;

function toWeek(r: Record<string, unknown>): NetaWeek {
  return {
    id: Number(r.id),
    title: String(r.title ?? "").trim(),
    startDate: String(r.start_date ?? ""),
    endDate: String(r.end_date ?? ""),
    isActive: r.is_active === true,
    liveRecordingDate: (r.live_recording_date as string | null) || null,
    liveUrl: (r.live_url as string | null) || null,
  };
}

const TOPIC_SELECT = `
  SELECT t.id, t.week_id, t.title, t.url, t.description, t.submitter, t.status, t.created_at,
         t.legacy_stars + (SELECT count(*) FROM neta_votes v WHERE v.topic_id = t.id)::int AS stars,
         (SELECT count(*) FROM neta_comments c WHERE c.topic_id = t.id)::int AS comments
    FROM neta_topics t`;

function toTopic(r: Record<string, unknown>): NetaTopic {
  return {
    id: Number(r.id),
    weekId: Number(r.week_id),
    title: String(r.title ?? ""),
    url: String(r.url ?? ""),
    description: (r.description as string | null) || null,
    submitter: String(r.submitter ?? ""),
    featured: r.status === "featured",
    stars: Number(r.stars ?? 0),
    comments: Number(r.comments ?? 0),
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** 今週（印のついた週。なければいちばん新しい週）。 */
export async function getCurrentWeek(): Promise<NetaWeek | null> {
  const r = await pool.query(`SELECT ${WEEK_COLS} FROM neta_weeks ORDER BY is_active DESC, id DESC LIMIT 1`);
  return r.rows[0] ? toWeek(r.rows[0]) : null;
}

export async function getWeek(id: number): Promise<NetaWeek | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const r = await pool.query(`SELECT ${WEEK_COLS} FROM neta_weeks WHERE id = $1`, [id]);
  return r.rows[0] ? toWeek(r.rows[0]) : null;
}

/** 週の切り替えに出す一覧（新しい順）。 */
export async function listWeeks(limit = 30): Promise<NetaWeek[]> {
  const r = await pool.query(`SELECT ${WEEK_COLS} FROM neta_weeks ORDER BY id DESC LIMIT $1`, [limit]);
  return r.rows.map(toWeek);
}

/** その週の話題。聞きたい順は同数なら新しい順（ネタ帳と同じ）。 */
export async function listTopics(weekId: number, sort: NetaSort = "stars"): Promise<NetaTopic[]> {
  const order = sort === "new" ? "t.created_at DESC, t.id DESC" : "stars DESC, t.created_at DESC, t.id DESC";
  const r = await pool.query(`${TOPIC_SELECT} WHERE t.week_id = $1 ORDER BY ${order} LIMIT ${NETA_LIST_LIMIT}`, [weekId]);
  return r.rows.map(toTopic);
}

export async function countTopics(weekId: number): Promise<number> {
  const r = await pool.query(`SELECT count(*)::int AS n FROM neta_topics WHERE week_id = $1`, [weekId]);
  return r.rows[0]?.n ?? 0;
}

export async function getTopic(id: number): Promise<{ topic: NetaTopic; week: NetaWeek | null; comments: NetaComment[] } | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const r = await pool.query(`${TOPIC_SELECT} WHERE t.id = $1`, [id]);
  if (!r.rows[0]) return null;
  const topic = toTopic(r.rows[0]);
  const [week, c] = await Promise.all([
    getWeek(topic.weekId),
    pool.query(`SELECT id, commenter, body, created_at FROM neta_comments WHERE topic_id = $1 ORDER BY created_at, id`, [id]),
  ]);
  return {
    topic,
    week,
    comments: c.rows.map((x) => ({
      id: Number(x.id),
      commenter: String(x.commenter ?? ""),
      body: String(x.body ?? ""),
      createdAt: new Date(x.created_at).toISOString(),
    })),
  };
}

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
