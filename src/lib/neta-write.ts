/**
 * 📝 ネタ帳の書き込み（docs/neta-integration-plan.md、第 2 段階）: 聞きたい・投稿・コメント・表示名。
 * 誰が書いたかは neta_members の id で持ち、公開ページに出す名前は本人がネタ帳で決めた表示名だけ。
 */
import { pool } from "./db";
import { hitLimit } from "./login";
import { isAdmin } from "./admin";
import { netaVoter, type NetaMember, type NetaViewer } from "./neta-auth";

export const NETA_TITLE_MAX = 200;
export const NETA_DESCRIPTION_MAX = 1000;
export const NETA_COMMENT_MAX = 1000;
export const NETA_NAME_MAX = 30;

export const NETA_LIMITS = {
  votePerMember: { limit: 200, window: "1 hour" },
  votePerIp: { limit: 600, window: "1 hour" },
  topicPerMember: { limit: 20, window: "1 hour" },
  topicPerIp: { limit: 60, window: "1 hour" },
  commentPerMember: { limit: 30, window: "1 hour" },
  commentPerIp: { limit: 100, window: "1 hour" },
} as const;

export class NetaError extends Error {
  constructor(readonly status: number, message: string, readonly code = "error", readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

const TOO_MANY = "回数が多すぎます。しばらくしてからもう一度お試しください";

/** 書き込みを開けているか。NETA_WRITE_ENABLED=1 で全員、それまでは B-guru の管理者だけ（試すため）。 */
export function netaWritable(viewer: Pick<NetaViewer, "email" | "tier"> | null): boolean {
  if (netaLive()) return true;
  return !!viewer && viewer.tier === "paid" && isAdmin(viewer.email);
}

/** 一行の文字（制御文字を外し、空白をまとめる）。 */
function oneLine(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return Array.from(s).slice(0, max).join("");
}

/** 複数行の文字（改行は残す。制御文字は外す）。長すぎるのは切らずに断る。 */
function multiLine(v: unknown): string {
  if (typeof v !== "string") return "";
  return v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** 投稿できる URL（http(s)・2000 字まで・ID/パスワード入りは不可）。正規化した文字列か null。 */
export function netaTopicUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 2000) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password) return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

export function netaDisplayName(raw: unknown): string {
  return oneLine(raw, NETA_NAME_MAX);
}

/** 出演者・運営と紛らわしい名前（なりすましよけ）。空白・記号・大文字小文字を無視して、含んでいたら使えない。 */
const RESERVED_NAMES = ["ドリキン", "drikin", "どりきん", "松尾", "matsuo", "西川善司", "善司", "zenji", "backspace", "バックスペース", "運営", "管理者", "公式", "bguru", "ビーグル"];
export function netaReservedName(name: string): boolean {
  const k = name.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
  return RESERVED_NAMES.some((r) => k.includes(r.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")));
}

export async function setDisplayName(member: NetaMember, raw: unknown): Promise<string> {
  const name = netaDisplayName(raw);
  if (!name) throw new NetaError(400, "名前を入れてください", "name");
  if (netaReservedName(name) && !isAdmin(member.email)) {
    throw new NetaError(400, "番組の出演者や運営と紛らわしい名前は使えません", "name");
  }
  await pool.query(`UPDATE neta_members SET display_name = $2 WHERE id = $1`, [member.id, name]);
  return name;
}

async function needName(member: NetaMember, raw: unknown): Promise<string> {
  if (raw !== undefined && raw !== null && raw !== "") return setDisplayName(member, raw);
  if (member.displayName) return member.displayName;
  throw new NetaError(400, "ネタ帳で表示する名前を決めてください", "need_name");
}

async function topicStars(topicId: number): Promise<number> {
  const r = await pool.query(
    `SELECT t.legacy_stars + (SELECT count(*) FROM neta_votes v WHERE v.topic_id = t.id)::int AS stars FROM neta_topics t WHERE t.id = $1`,
    [topicId]
  );
  return Number(r.rows[0]?.stars ?? 0);
}

/** 聞きたいを入れる（on=true）・外す（on=false）。何度押しても同じ結果。 */
export async function setVote(member: NetaMember, topicId: number, on: boolean, ip: string | null = null): Promise<{ voted: boolean; stars: number }> {
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new NetaError(404, "ネタが見つかりません");
  const exists = await pool.query(`SELECT 1 FROM neta_topics WHERE id = $1`, [topicId]);
  if (!exists.rows[0]) throw new NetaError(404, "ネタが見つかりません");
  if (!(await hitLimit(`neta-vote:${member.id}`, NETA_LIMITS.votePerMember))) throw new NetaError(429, TOO_MANY);
  // 同じ IP から別名を量産して票を入れる水増しよけ（1 つの家や会社の回線から大勢が押しても足りる数）。
  if (ip && !(await hitLimit(`neta-vote-ip:${ip}`, NETA_LIMITS.votePerIp))) throw new NetaError(429, TOO_MANY);
  const voter = netaVoter(member.id);
  if (on) {
    await pool.query(`INSERT INTO neta_votes (topic_id, voter) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [topicId, voter]);
  } else {
    await pool.query(`DELETE FROM neta_votes WHERE topic_id = $1 AND voter = $2`, [topicId, voter]);
  }
  return { voted: on, stars: await topicStars(topicId) };
}

/** 切り替え済みか（neta.backspace.fm から B-guru へ。書き込みを全員に開け、検索に載せ、拡張の受け口を開ける）。 */
export function netaLive(): boolean {
  return process.env.NETA_WRITE_ENABLED === "1";
}

export type TopicFields = { url: string; title: string; description: string };

/** 投稿の中身を確かめる（名前は別）。 */
export function parseTopic(input: { title?: unknown; url?: unknown; description?: unknown }): TopicFields {
  const url = netaTopicUrl(input.url);
  if (!url) throw new NetaError(400, "記事の URL（http:// か https://）を入れてください", "url");
  const title = oneLine(input.title, NETA_TITLE_MAX);
  if (!title) throw new NetaError(400, "タイトルを入れてください", "title");
  const description = multiLine(input.description);
  if (Array.from(description).length > NETA_DESCRIPTION_MAX) {
    throw new NetaError(400, `説明は ${NETA_DESCRIPTION_MAX} 字までです`, "description");
  }
  return { url, title, description };
}

/**
 * 今週に 1 つ入れる（共通部分）。同じ週に同じ URL があれば 409（そのネタを返す）。
 * memberId があれば、その人の聞きたいを 1 つ入れる（拡張や B-guru からの送信は人に紐付かないので null）。
 */
export async function insertTopic(f: TopicFields, submitter: string, memberId: number | null): Promise<{ id: number }> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const week = await c.query(`SELECT id FROM neta_weeks WHERE is_active LIMIT 1`);
    if (!week.rows[0]) throw new NetaError(400, "今週の受付がまだ始まっていません", "no_week");
    const weekId = Number(week.rows[0].id);
    // 同じ週の同じ URL を 2 人が同時に送っても 1 つにする（週ごとにロック）。
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('neta-topic-week'), $1)`, [weekId]);
    const dup = await c.query(`SELECT id, title, submitter FROM neta_topics WHERE week_id = $1 AND url = $2 LIMIT 1`, [weekId, f.url]);
    if (dup.rows[0]) {
      throw new NetaError(409, "この週にこの URL はもう投稿されています", "duplicate", {
        existing: { id: Number(dup.rows[0].id), title: String(dup.rows[0].title), submitter: String(dup.rows[0].submitter) },
      });
    }
    const ins = await c.query(
      `INSERT INTO neta_topics (week_id, title, url, description, submitter, member_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [weekId, f.title, f.url, f.description || null, submitter, memberId]
    );
    const id = Number(ins.rows[0].id);
    if (memberId) {
      await c.query(`INSERT INTO neta_votes (topic_id, voter) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, netaVoter(memberId)]);
    }
    await c.query("COMMIT");
    return { id };
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** 今週にネタを投稿する（ログインした人）。投稿した人の聞きたいを 1 つ入れる。 */
export async function createTopic(
  member: NetaMember,
  ip: string | null,
  input: { title?: unknown; url?: unknown; description?: unknown; name?: unknown }
): Promise<{ id: number }> {
  const f = parseTopic(input);
  const name = await needName(member, input.name);
  if (!(await hitLimit(`neta-topic:${member.id}`, NETA_LIMITS.topicPerMember))) throw new NetaError(429, TOO_MANY);
  if (ip && !(await hitLimit(`neta-topic-ip:${ip}`, NETA_LIMITS.topicPerIp))) throw new NetaError(429, TOO_MANY);
  return insertTopic(f, name, member.id);
}

/** Chrome 拡張（昔の版のまま）からの投稿: ログインなし・名前は入力のまま（オーナー 2026-11-13「今までどおり受ける」）。IP ごとに制限。 */
export const NETA_COMPAT_LIMIT = { limit: 10, window: "1 hour" } as const;
export async function createTopicFromExtension(
  ip: string | null,
  input: { title?: unknown; url?: unknown; description?: unknown; submitter?: unknown }
): Promise<{ id: number }> {
  const f = parseTopic(input);
  const name = netaDisplayName(input.submitter);
  if (!name) throw new NetaError(400, "名前を入れてください", "name");
  if (netaReservedName(name)) throw new NetaError(400, "番組の出演者や運営と紛らわしい名前は使えません", "name");
  if (!ip) throw new NetaError(400, "送り元が分かりません");
  if (!(await hitLimit(`neta-compat-ip:${ip}`, NETA_COMPAT_LIMIT))) throw new NetaError(429, TOO_MANY);
  return insertTopic(f, name, null);
}

export async function addComment(
  member: NetaMember,
  ip: string | null,
  topicId: number,
  input: { body?: unknown; name?: unknown }
): Promise<{ id: number }> {
  if (!Number.isSafeInteger(topicId) || topicId <= 0) throw new NetaError(404, "ネタが見つかりません");
  const body = multiLine(input.body);
  if (!body) throw new NetaError(400, "コメントを入れてください", "body");
  if (Array.from(body).length > NETA_COMMENT_MAX) throw new NetaError(400, `コメントは ${NETA_COMMENT_MAX} 字までです`, "body");
  const exists = await pool.query(`SELECT 1 FROM neta_topics WHERE id = $1`, [topicId]);
  if (!exists.rows[0]) throw new NetaError(404, "ネタが見つかりません");
  const name = await needName(member, input.name);
  if (!(await hitLimit(`neta-comment:${member.id}`, NETA_LIMITS.commentPerMember))) throw new NetaError(429, TOO_MANY);
  if (ip && !(await hitLimit(`neta-comment-ip:${ip}`, NETA_LIMITS.commentPerIp))) throw new NetaError(429, TOO_MANY);
  const r = await pool.query(
    `INSERT INTO neta_comments (topic_id, commenter, body, member_id) VALUES ($1,$2,$3,$4) RETURNING id`,
    [topicId, name, body, member.id]
  );
  return { id: Number(r.rows[0].id) };
}

/** 見ている人が聞きたいを入れたネタ（一覧の印用）。 */
export async function votedTopicIds(memberId: number | null | undefined, topicIds: number[]): Promise<Set<number>> {
  if (!memberId || topicIds.length === 0) return new Set();
  const r = await pool.query(`SELECT topic_id FROM neta_votes WHERE voter = $1 AND topic_id = ANY($2::int[])`, [
    netaVoter(memberId),
    topicIds,
  ]);
  return new Set(r.rows.map((x) => Number(x.topic_id)));
}
