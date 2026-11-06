/* 👥 グループ DM — 有料会員どうしの 3 人以上（2 人も可）の DM。テキストだけ、30 日で消える。docs/group-dm-spec.md。
 *
 *   - 表は gdm_groups / gdm_members / gdm_messages（db.ts）。1 対 1（dm.ts）とは別。
 *   - 読めるのはメンバーだけ。途中から入った人は入る前の発言を見られない（joined_from_id）。
 *   - 送り主・操作する人は常にサーバの認証から決める（クライアントの申告は信じない）。
 *   - 応答・配信の DTO にメールは入れない（users.user_id）。
 *   - 追加はメンバーなら誰でも、外すのは作った人だけ、抜けるのは誰でも（オーナー決定 2026-11-06）。
 *   - 発言は全部 push、グループごとに自分で通知を切れる（muted）。
 *   - GROUP_DM_ENABLED（かつ DM_ENABLED）の対象の人だけ。 */
import path from "path";
import crypto from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import sharp from "sharp";
import { pool } from "./db";
import { withImageSlot } from "./image-resize";
import { gravatarUrl, SYSTEM_EMAIL } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emailToUserIds } from "./user";
import { featureEnabledFor } from "./feature-flag";
import { emitPersonal } from "./personal-live";
import { pushGdm, syncRead } from "./push-notify";
import {
  DM_MAX_BODY,
  DM_PAGE_LIMIT,
  DM_TTL,
  DM_TTL_HOURS,
  DmError,
  checkDmRate,
  dmEnabledFor,
  isActiveMember,
  normEmail,
  normalizeDmBody,
  normalizeDmClientId,
  validPeerId,
  type DmActor,
} from "./dm";

export const GDM_FLAG = "GROUP_DM_ENABLED";
export function gdmEnabledFor(email: string | null | undefined): boolean {
  return dmEnabledFor(email) && featureEnabledFor(GDM_FLAG, email);
}

/** 1 グループの人数の安全弁（仕様の上限ではない。通知を一度に配る負荷を抑えるため）。 */
export const GDM_MAX_MEMBERS = 100;
export const GDM_MAX_NAME = 40;
/** 作る・追加する（1 人あたり 1 時間）。発言は 1 対 1 と同じカウンタ。 */
export const GDM_ADMIN_RATE_LIMIT = 30;
export const GDM_GROUPS_LIMIT = 100;
/** 自分で抜けた人を同じグループに入れ直せない時間。 */
export const GDM_REJOIN_COOLDOWN = "24 hours";

export type GMember = { user_id: string; name: string | null; avatar: string | null; is_creator: boolean; is_me: boolean };
export type GroupDto = {
  id: number;
  name: string | null;
  title: string;
  /** グループの写真（メンバーだけが読める。Web はクッキー、アプリは鍵で）。無ければ null。 */
  photo: string | null;
  members: GMember[];
  member_count: number;
  is_creator: boolean;
  muted: boolean;
  created_at: string;
};
export type GMessageDto = {
  id: number;
  group_id: number;
  kind: "text" | "system";
  from_id: string | null;
  from_name: string | null;
  from_avatar: string | null;
  body: string;
  created_at: string;
  is_author: boolean;
  client_id?: string;
};
export type GroupSummaryDto = { group: GroupDto; last_message: GMessageDto | null; unread_count: number };

type GroupRow = { id: number; name: string | null; creator_email: string; created_at: Date | string; photo?: string | null };
type MemberRow = { email: string; joined_at: Date | string; joined_from_id: number; muted: boolean; last_read_id: number };
type MsgRow = { id: number; group_id: number; sender_email: string | null; kind: string; body: string; created_at: Date | string };

/** 名前・ID の引き当て（DTO を作るのに要るもの）。 */
type Lookup = { ids: Map<string, string>; names: Map<string, string | null> };

async function lookup(emails: string[]): Promise<Lookup> {
  const uniq = [...new Set(emails.map(normEmail).filter(Boolean))];
  const [ids, names] = await Promise.all([emailToUserIds(uniq), resolveDisplayNames(uniq)]);
  return { ids, names };
}

// ---- 純粋な部分（テストする） ----

/** グループ名の正規化: 前後の空白を落とし、改行は空白に。空なら null。長すぎは不可。 */
export function normalizeGroupName(raw: unknown): { ok: true; name: string | null } | { ok: false } {
  if (raw == null) return { ok: true, name: null };
  if (typeof raw !== "string") return { ok: false };
  // 改行・タブは空白に、ゼロ幅文字と文字の向きを変える制御文字は落とす
  const name = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, "")
    .trim();
  if (!name) return { ok: true, name: null };
  if ([...name].length > GDM_MAX_NAME) return { ok: false };
  return { ok: true, name };
}

/** 表示名: 付けた名前か、自分以外のメンバーの名前（3 人まで＋「ほか N 人」）。 */
export function groupTitle(name: string | null, otherNames: (string | null)[]): string {
  if (name) return name;
  const shown = otherNames.slice(0, 3).map((n) => n || "だれか");
  if (shown.length === 0) return "（自分だけ）";
  const rest = otherNames.length - shown.length;
  return shown.join("、") + (rest > 0 ? ` ほか ${rest} 人` : "");
}

/** 写真の URL（ファイル名が変わると ?v= も変わるので、端末のキャッシュは古いものを出さない）。 */
export function photoUrl(gid: number, file: string | null): string | null {
  if (!file) return null;
  const v = file.replace(/\.[a-z]+$/, "").split("-").pop() ?? "";
  return `/api/gdm/${gid}/photo?v=${encodeURIComponent(v)}`;
}

function displayName(email: string, names: Map<string, string | null>): string {
  if (normEmail(email) === SYSTEM_EMAIL) return "ビーグル";
  return names.get(normEmail(email)) || "だれか";
}

export function toGroupDto(g: GroupRow, members: MemberRow[], viewerEmail: string, lk: Lookup): GroupDto {
  const me = normEmail(viewerEmail);
  const creator = normEmail(g.creator_email);
  const list: GMember[] = [];
  const others: (string | null)[] = [];
  let muted = false;
  // 作った人を先頭に、あとは入った順
  const ordered = [...members.filter((m) => normEmail(m.email) === creator), ...members.filter((m) => normEmail(m.email) !== creator)];
  for (const m of ordered) {
    const e = normEmail(m.email);
    const uid = lk.ids.get(e);
    if (!uid) continue;
    const name = lk.names.get(e) ?? null;
    list.push({ user_id: uid, name, avatar: gravatarUrl(e), is_creator: e === creator, is_me: e === me });
    if (e === me) muted = !!m.muted;
    else others.push(name);
  }
  return {
    id: g.id,
    name: g.name,
    title: groupTitle(g.name, others),
    photo: photoUrl(g.id, g.photo ?? null),
    members: list,
    member_count: list.length,
    is_creator: creator === me,
    muted,
    created_at: new Date(g.created_at).toISOString(),
  };
}

export function toGMessageDto(r: MsgRow, viewerEmail: string, lk: Lookup, clientId?: string | null): GMessageDto {
  const from = r.sender_email ? normEmail(r.sender_email) : null;
  const mine = !!from && from === normEmail(viewerEmail);
  const dto: GMessageDto = {
    id: r.id,
    group_id: r.group_id,
    kind: r.kind === "system" ? "system" : "text",
    from_id: from ? (lk.ids.get(from) ?? null) : null,
    from_name: from ? (lk.names.get(from) ?? null) : null,
    from_avatar: from ? gravatarUrl(from) : null,
    body: r.body,
    created_at: new Date(r.created_at).toISOString(),
    is_author: mine,
  };
  if (mine && clientId) dto.client_id = clientId;
  return dto;
}

// ---- DB ----

async function checkAdminRate(email: string): Promise<void> {
  const res = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN rate_limits.window_start < now() - interval '1 hour' THEN now() ELSE rate_limits.window_start END,
       count = CASE WHEN rate_limits.window_start < now() - interval '1 hour' THEN 1 ELSE rate_limits.count + 1 END
     RETURNING count, window_start`,
    [`gdm-admin:${normEmail(email)}`]
  );
  if (Number(res.rows[0].count) <= GDM_ADMIN_RATE_LIMIT) return;
  const started = new Date(res.rows[0].window_start).getTime();
  throw new DmError(429, "rate_limited", "グループの操作が多すぎます。しばらく待ってください", Math.max(1, Math.ceil((started + 3600_000 - Date.now()) / 1000)));
}

function parseGroupId(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new DmError(400, "invalid_request", "グループが不正です");
  return n;
}

async function loadGroup(gid: number): Promise<{ group: GroupRow; members: MemberRow[] } | null> {
  const [g, m] = await Promise.all([
    pool.query(`SELECT id, name, creator_email, created_at, photo FROM gdm_groups WHERE id = $1`, [gid]),
    pool.query(
      `SELECT email, joined_at, joined_from_id, muted, last_read_id FROM gdm_members WHERE group_id = $1 ORDER BY joined_at, email`,
      [gid]
    ),
  ]);
  if (!g.rows[0]) return null;
  return { group: g.rows[0] as GroupRow, members: m.rows as MemberRow[] };
}

/** メンバーでなければ 404（グループがあるかどうかも明かさない）。 */
async function requireMember(actor: DmActor, rawGid: unknown) {
  const gid = parseGroupId(rawGid);
  const loaded = await loadGroup(gid);
  const me = normEmail(actor.email);
  const self = loaded?.members.find((m) => normEmail(m.email) === me);
  if (!loaded || !self) throw new DmError(404, "not_found", "グループが見つかりません");
  return { gid, ...loaded, self };
}

/** 追加する人の user_id → email（重複・不正・自分・ビーグル・知らない人・使えない人は断る）。 */
async function resolveNewMembers(actor: DmActor, raw: unknown, existing: Set<string>): Promise<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) throw new DmError(400, "invalid_request", "メンバーを選んでください");
  if (raw.length > GDM_MAX_MEMBERS) throw new DmError(400, "invalid_request", `一度に ${GDM_MAX_MEMBERS} 人までです`);
  const ids = [...new Set(raw)];
  if (!ids.every(validPeerId)) throw new DmError(400, "invalid_request", "メンバーが不正です");
  const r = await pool.query(`SELECT user_id, lower(email) AS email FROM users WHERE user_id = ANY($1::text[])`, [ids]);
  const byId = new Map<string, string>((r.rows as { user_id: string; email: string }[]).map((x) => [x.user_id, x.email]));
  const me = normEmail(actor.email);
  const out: string[] = [];
  for (const id of ids as string[]) {
    const email = byId.get(id);
    if (!email || email === SYSTEM_EMAIL) throw new DmError(404, "not_found", "相手が見つかりません");
    if (email === me || id === actor.userId) continue; // 自分は入れない（作る人は自動で入る）
    if (existing.has(email)) continue;
    if (!gdmEnabledFor(email) || !(await isActiveMember(email))) {
      throw new DmError(403, "forbidden", "グループ DM に入れられない人がいます");
    }
    out.push(email);
  }
  return out;
}

/** 各メンバーのグループ DM の未読の合計（1 回のクエリ）。 */
export async function gdmUnreadTotals(emails: string[]): Promise<Map<string, number>> {
  const list = [...new Set(emails.map(normEmail))];
  const out = new Map<string, number>(list.map((e) => [e, 0]));
  if (list.length === 0) return out;
  const r = await pool.query(
    `SELECT gm.email, count(*)::int AS c
       FROM gdm_members gm
       JOIN gdm_messages m ON m.group_id = gm.group_id
      WHERE gm.email = ANY($1::text[])
        AND m.kind = 'text'
        AND m.sender_email IS DISTINCT FROM gm.email
        AND m.id > GREATEST(gm.last_read_id, gm.joined_from_id)
        AND m.created_at >= now() - ($2::text)::interval
      GROUP BY gm.email`,
    [list, DM_TTL]
  );
  for (const row of r.rows as { email: string; c: number }[]) out.set(row.email, row.c);
  return out;
}

export async function getGdmUnreadTotal(email: string): Promise<number> {
  return (await gdmUnreadTotals([email])).get(normEmail(email)) ?? 0;
}

/** 1 つのグループの、自分の未読。 */
async function unreadIn(gid: number, email: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS c
       FROM gdm_members gm JOIN gdm_messages m ON m.group_id = gm.group_id
      WHERE gm.group_id = $1 AND gm.email = $2 AND m.kind = 'text'
        AND m.sender_email IS DISTINCT FROM gm.email
        AND m.id > GREATEST(gm.last_read_id, gm.joined_from_id)
        AND m.created_at >= now() - ($3::text)::interval`,
    [gid, normEmail(email), DM_TTL]
  );
  return r.rows[0]?.c ?? 0;
}

/** グループの今の形をメンバー全員へ（見る人ごとに作る）。 */
async function emitGroupToMembers(gid: number): Promise<void> {
  const loaded = await loadGroup(gid);
  if (!loaded) return;
  const lk = await lookup(loaded.members.map((m) => m.email));
  for (const m of loaded.members) {
    emitPersonal(normEmail(m.email), { type: "gdm", data: { action: "group", group: toGroupDto(loaded.group, loaded.members, m.email, lk) } });
  }
}

/** 発言（system 行も）を書き、メンバー全員へ配る。text なら送った人と通知を切った人以外へ push。 */
async function insertMessage(
  gid: number,
  senderEmail: string | null,
  kind: "text" | "system",
  body: string,
  clientId: string | null = null
): Promise<{ row: MsgRow; members: MemberRow[]; lk: Lookup }> {
  const ins = await pool.query(
    `INSERT INTO gdm_messages (group_id, sender_email, kind, body) VALUES ($1, $2, $3, $4)
     RETURNING id, group_id, sender_email, kind, body, created_at`,
    [gid, senderEmail, kind, body]
  );
  const row = ins.rows[0] as MsgRow;
  await pool.query(`UPDATE gdm_groups SET updated_at = now() WHERE id = $1`, [gid]);
  if (senderEmail) {
    // 送ったら、そこまで見たことにする。
    await pool.query(`UPDATE gdm_members SET last_read_id = GREATEST(last_read_id, $3) WHERE group_id = $1 AND email = $2`, [
      gid,
      normEmail(senderEmail),
      row.id,
    ]);
  }
  const loaded = await loadGroup(gid);
  const members = loaded?.members ?? [];
  const lk = await lookup([...members.map((m) => m.email), ...(senderEmail ? [senderEmail] : [])]);
  const totals = await gdmUnreadTotals(members.map((m) => m.email)).catch(() => new Map<string, number>());
  for (const m of members) {
    const e = normEmail(m.email);
    emitPersonal(e, {
      type: "gdm",
      data: {
        action: "create",
        group_id: gid,
        message: toGMessageDto(row, e, lk, clientId),
        ...(totals.has(e) ? { group_unread_count: totals.get(e) } : {}),
      },
    });
  }
  if (kind === "text") {
    const sender = senderEmail ? normEmail(senderEmail) : "";
    const cand = members.filter((m) => normEmail(m.email) !== sender && !m.muted && gdmEnabledFor(m.email)).map((m) => normEmail(m.email));
    // 会員でなくなった人（鍵もセッションも無い）には送らない（本文を読めず決まり文句だけが届き続けるため）
    void activeMembers(cand)
      .then((to) => pushGdm(to, row.id, gid))
      .catch((e) => console.error("gdm push:", (e as Error)?.message));
  }
  return { row, members, lk };
}

/** いま会員としてログインしている人だけ（isActiveMember を 1 回のクエリで）。 */
async function activeMembers(emails: string[]): Promise<string[]> {
  if (emails.length === 0) return [];
  const r = await pool.query(
    `SELECT e FROM unnest($1::text[]) AS e
      WHERE EXISTS (SELECT 1 FROM sessions WHERE lower(email) = e AND expires_at > now())
         OR EXISTS (SELECT 1 FROM agent_tokens WHERE lower(email) = e AND revoked_at IS NULL AND expires_at > now())`,
    [emails]
  );
  return (r.rows as { e: string }[]).map((x) => x.e);
}

function namesLine(emails: string[], names: Map<string, string | null>): string {
  return emails.map((e) => displayName(e, names)).join("、");
}

// ---- 公開する操作 ----

/** グループの一覧（最後の動きが新しい順）と未読の合計。 */
export async function listGroups(actor: DmActor): Promise<{ groups: GroupSummaryDto[]; group_unread_count: number }> {
  const me = normEmail(actor.email);
  const gr = await pool.query(
    `SELECT g.id, g.name, g.creator_email, g.created_at, g.photo
       FROM gdm_groups g JOIN gdm_members gm ON gm.group_id = g.id AND gm.email = $1
      ORDER BY g.updated_at DESC, g.id DESC
      LIMIT $2`,
    [me, GDM_GROUPS_LIMIT]
  );
  const groups = gr.rows as GroupRow[];
  if (groups.length === 0) return { groups: [], group_unread_count: 0 };
  const gids = groups.map((g) => g.id);
  const [mr, last, unread] = await Promise.all([
    pool.query(
      `SELECT group_id, email, joined_at, joined_from_id, muted, last_read_id FROM gdm_members WHERE group_id = ANY($1::int[]) ORDER BY joined_at, email`,
      [gids]
    ),
    pool.query(
      `SELECT DISTINCT ON (m.group_id) m.id, m.group_id, m.sender_email, m.kind, m.body, m.created_at
         FROM gdm_messages m JOIN gdm_members gm ON gm.group_id = m.group_id AND gm.email = $2
        WHERE m.group_id = ANY($1::int[]) AND m.id > gm.joined_from_id AND m.created_at >= now() - ($3::text)::interval
        ORDER BY m.group_id, m.id DESC`,
      [gids, me, DM_TTL]
    ),
    pool.query(
      `SELECT gm.group_id, count(*)::int AS c
         FROM gdm_members gm JOIN gdm_messages m ON m.group_id = gm.group_id
        WHERE gm.email = $1 AND gm.group_id = ANY($2::int[]) AND m.kind = 'text'
          AND m.sender_email IS DISTINCT FROM gm.email
          AND m.id > GREATEST(gm.last_read_id, gm.joined_from_id)
          AND m.created_at >= now() - ($3::text)::interval
        GROUP BY gm.group_id`,
      [me, gids, DM_TTL]
    ),
  ]);
  const membersBy = new Map<number, MemberRow[]>();
  for (const r of mr.rows as (MemberRow & { group_id: number })[]) {
    const arr = membersBy.get(r.group_id) ?? [];
    arr.push(r);
    membersBy.set(r.group_id, arr);
  }
  const lastBy = new Map<number, MsgRow>((last.rows as MsgRow[]).map((r) => [r.group_id, r]));
  const unreadBy = new Map<number, number>((unread.rows as { group_id: number; c: number }[]).map((r) => [r.group_id, r.c]));
  const allEmails = [...(mr.rows as MemberRow[]).map((r) => r.email), ...(last.rows as MsgRow[]).flatMap((r) => (r.sender_email ? [r.sender_email] : []))];
  const lk = await lookup(allEmails);
  let total = 0;
  const out: GroupSummaryDto[] = groups.map((g) => {
    const u = unreadBy.get(g.id) ?? 0;
    total += u;
    const l = lastBy.get(g.id);
    return { group: toGroupDto(g, membersBy.get(g.id) ?? [], me, lk), last_message: l ? toGMessageDto(l, me, lk) : null, unread_count: u };
  });
  // 合計は一覧の上限（100 件）に関係なく全部（stream の group_unread_count と同じ数え方）
  return { groups: out, group_unread_count: groups.length >= GDM_GROUPS_LIMIT ? await getGdmUnreadTotal(me) : total };
}

/** 作る。自分のほかに 1 人以上。作った人は自分。 */
export async function createGroup(actor: DmActor, rawName: unknown, rawMemberIds: unknown): Promise<GroupDto> {
  const me = normEmail(actor.email);
  if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  const nm = normalizeGroupName(rawName);
  if (!nm.ok) throw new DmError(400, "invalid_request", `グループ名は ${GDM_MAX_NAME} 文字までです`);
  await checkAdminRate(me); // 先に数える（入れられない人の判定で、相手の状態を何度も探られないように）
  const others = await resolveNewMembers(actor, rawMemberIds, new Set([me]));
  if (others.length === 0) throw new DmError(400, "invalid_request", "自分のほかに 1 人以上選んでください");
  if (others.length + 1 > GDM_MAX_MEMBERS) throw new DmError(400, "invalid_request", `1 グループ ${GDM_MAX_MEMBERS} 人までです`);

  const client = await pool.connect();
  let gid: number;
  try {
    await client.query("BEGIN");
    const g = await client.query(`INSERT INTO gdm_groups (name, creator_email) VALUES ($1, $2) RETURNING id`, [nm.name, me]);
    gid = g.rows[0].id as number;
    const from = await client.query(`SELECT COALESCE(max(id), 0)::int AS m FROM gdm_messages`);
    const fromId = from.rows[0].m as number;
    await client.query(
      `INSERT INTO gdm_members (group_id, email, joined_from_id, added_by)
       SELECT $1, e, $2, $3 FROM unnest($4::text[]) AS e`,
      [gid, fromId, me, [me, ...others]]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  // 先にグループを配る（新しいメンバーの端末が、知らないグループの発言を受け取らないように）。
  await emitGroupToMembers(gid);
  const names = await resolveDisplayNames([me, ...others]);
  await insertMessage(gid, null, "system", `${displayName(me, names)}がグループを作りました（${namesLine(others, names)}）`);
  const loaded = await loadGroup(gid);
  const lk = await lookup(loaded!.members.map((m) => m.email));
  return toGroupDto(loaded!.group, loaded!.members, me, lk);
}

/** 1 つのグループの発言（古い→新しい、30 日以内、入ってから）。 */
export async function getGroupThread(
  actor: DmActor,
  rawGid: unknown,
  opts: { before?: number; limit?: number } = {}
): Promise<{ group: GroupDto; messages: GMessageDto[]; unread_count: number; last_read_id: number; can_send: boolean }> {
  const { gid, group, members, self } = await requireMember(actor, rawGid);
  const me = normEmail(actor.email);
  const limit = Math.min(Math.max(opts.limit ?? DM_PAGE_LIMIT, 1), DM_PAGE_LIMIT);
  const res = await pool.query(
    `SELECT id, group_id, sender_email, kind, body, created_at FROM gdm_messages
      WHERE group_id = $1 AND id > $2 AND created_at >= now() - ($3::text)::interval
        AND ($4::int IS NULL OR id < $4)
      ORDER BY id DESC LIMIT $5`,
    [gid, self.joined_from_id, DM_TTL, opts.before ?? null, limit]
  );
  const rows = (res.rows as MsgRow[]).reverse();
  const lk = await lookup([...members.map((m) => m.email), ...rows.flatMap((r) => (r.sender_email ? [r.sender_email] : []))]);
  const messages = rows.map((r) => toGMessageDto(r, me, lk));
  const lastRead = Math.max(Number(self.last_read_id), Number(self.joined_from_id));
  const unread = messages.filter((m) => m.kind === "text" && !m.is_author && m.id > lastRead).length;
  return { group: toGroupDto(group, members, me, lk), messages, unread_count: unread, last_read_id: Number(self.last_read_id), can_send: gdmEnabledFor(me) };
}

const SEND_DEDUP_TTL_MS = 10 * 60_000;
const SEND_DEDUP_MAX = 2000;
const recentSends = new Map<string, { at: number; p: Promise<GMessageDto> }>();

/** 送る。返り値は送り主から見た DTO。client_id の再送は 2 重に入れない。 */
export async function sendGroupMessage(actor: DmActor, rawGid: unknown, rawBody: unknown, rawClientId: unknown = null): Promise<GMessageDto> {
  const checked = normalizeDmBody(rawBody);
  if (!checked.ok) throw new DmError(400, "invalid_request", checked.error === "empty" ? "本文が空です" : `本文が長すぎます（${DM_MAX_BODY} 文字まで）`);
  const clientId = normalizeDmClientId(rawClientId);
  if (!clientId) return insertText(actor, rawGid, checked.body, null);
  await requireMember(actor, rawGid); // 再送の重複よけより先に（外された人の再送を送れたことにしない）
  const now = Date.now();
  for (const [k, v] of recentSends) {
    if (recentSends.size <= SEND_DEDUP_MAX && now - v.at < SEND_DEDUP_TTL_MS) break;
    recentSends.delete(k);
  }
  const key = `${normEmail(actor.email)}\u0000${String(rawGid)}\u0000${clientId}`;
  const hit = recentSends.get(key);
  if (hit && now - hit.at < SEND_DEDUP_TTL_MS) return { ...(await hit.p) };
  const p = insertText(actor, rawGid, checked.body, clientId);
  recentSends.set(key, { at: now, p });
  try {
    return await p;
  } catch (e) {
    recentSends.delete(key);
    throw e;
  }
}

async function insertText(actor: DmActor, rawGid: unknown, body: string, clientId: string | null): Promise<GMessageDto> {
  const me = normEmail(actor.email);
  if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  const { gid } = await requireMember(actor, rawGid);
  const rate = await checkDmRate(me);
  if (!rate.allowed) throw new DmError(429, "rate_limited", "DM を送りすぎです。しばらく待ってください", rate.retryAfter);
  const { row, lk } = await insertMessage(gid, me, "text", body, clientId);
  return toGMessageDto(row, me, lk, clientId);
}

/** 既読を進める（単調）。自分のほかの端末にも知らせる。 */
export async function markGroupRead(actor: DmActor, rawGid: unknown, lastReadId: unknown): Promise<{ unread_count: number; group_unread_count: number }> {
  const { gid } = await requireMember(actor, rawGid);
  const n = Number(lastReadId);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new DmError(400, "invalid_request", "last_read_id が不正です");
  const me = normEmail(actor.email);
  const r = await pool.query(
    // まだ無い発言の id までは進めない（先の発言がずっと未読にならなくなるのを防ぐ）
    `UPDATE gdm_members
        SET last_read_id = GREATEST(last_read_id, LEAST($3, COALESCE((SELECT max(id) FROM gdm_messages WHERE group_id = $1), 0)))
      WHERE group_id = $1 AND email = $2 RETURNING last_read_id`,
    [gid, me, n]
  );
  const upTo = Number(r.rows[0]?.last_read_id ?? n);
  const [unread, total] = await Promise.all([unreadIn(gid, me), getGdmUnreadTotal(me)]);
  emitPersonal(me, { type: "gdm", data: { action: "read", group_id: gid, last_read_id: upTo, unread_count: unread, group_unread_count: total } });
  void syncRead(me, { scope: "gdm", group_id: gid, up_to: upTo }).catch((e) => console.error("[sync] gdm:", (e as Error)?.message));
  return { unread_count: unread, group_unread_count: total };
}

/** 名前を変える（メンバー誰でも）・自分の通知を切る／戻す。 */
export async function updateGroup(actor: DmActor, rawGid: unknown, input: Record<string, unknown>): Promise<GroupDto> {
  const { gid, group } = await requireMember(actor, rawGid);
  const me = normEmail(actor.email);
  let nameChanged = false;
  if ("muted" in input) {
    if (typeof input.muted !== "boolean") throw new DmError(400, "invalid_request", "muted が不正です");
    await pool.query(`UPDATE gdm_members SET muted = $3 WHERE group_id = $1 AND email = $2`, [gid, me, input.muted]);
  }
  if ("name" in input) {
    if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
    const nm = normalizeGroupName(input.name);
    if (!nm.ok) throw new DmError(400, "invalid_request", `グループ名は ${GDM_MAX_NAME} 文字までです`);
    if (nm.name !== group.name) {
      nameChanged = true;
      await checkAdminRate(me); // 名前を変えるのも数える（system 行と配信を増やせないように）
      await pool.query(`UPDATE gdm_groups SET name = $2, updated_at = now() WHERE id = $1`, [gid, nm.name]);
      const names = await resolveDisplayNames([me]);
      await insertMessage(
        gid,
        null,
        "system",
        nm.name ? `${displayName(me, names)}がグループ名を「${nm.name}」にしました` : `${displayName(me, names)}がグループ名を消しました`
      );
      await emitGroupToMembers(gid);
    }
  }
  const loaded = await loadGroup(gid);
  const lk = await lookup(loaded!.members.map((m) => m.email));
  const dto = toGroupDto(loaded!.group, loaded!.members, me, lk);
  // mute は自分だけの話なので、自分のほかの端末にだけ知らせる。
  if ("muted" in input && !nameChanged) emitPersonal(me, { type: "gdm", data: { action: "group", group: dto } });
  return dto;
}

/** 追加（メンバーなら誰でも）。 */
export async function addMembers(actor: DmActor, rawGid: unknown, rawIds: unknown): Promise<GroupDto> {
  const me = normEmail(actor.email);
  if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  const { gid, members } = await requireMember(actor, rawGid);
  await checkAdminRate(me);
  const existing = new Set(members.map((m) => normEmail(m.email)));
  const add = await resolveNewMembers(actor, rawIds, existing);
  if (add.length === 0) throw new DmError(400, "invalid_request", "追加する人がいません");
  // 自分で抜けた人は、そのグループに 24 時間入れ直せない（承諾なしの追加をくり返す嫌がらせを止める）。
  const recent = await pool.query(
    `SELECT 1 FROM gdm_leaves WHERE group_id = $1 AND email = ANY($2::text[]) AND left_at > now() - ($3::text)::interval LIMIT 1`,
    [gid, add, GDM_REJOIN_COOLDOWN]
  );
  if (recent.rowCount) throw new DmError(403, "forbidden", "最近このグループから抜けた人は、しばらく追加できません");
  const client = await pool.connect();
  let added: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(`SELECT id FROM gdm_groups WHERE id = $1 FOR UPDATE`, [gid]);
    // 鍵を取ってから、操作する人がまだメンバーかを確かめ直す（同時に外されていたら断る）
    const still = await client.query(`SELECT 1 FROM gdm_members WHERE group_id = $1 AND email = $2`, [gid, me]);
    if (!still.rowCount) throw new DmError(404, "not_found", "グループが見つかりません");
    const cnt = await client.query(`SELECT count(*)::int AS c FROM gdm_members WHERE group_id = $1`, [gid]);
    if ((cnt.rows[0].c as number) + add.length > GDM_MAX_MEMBERS) {
      throw new DmError(400, "invalid_request", `1 グループ ${GDM_MAX_MEMBERS} 人までです`);
    }
    const from = await client.query(`SELECT COALESCE(max(id), 0)::int AS m FROM gdm_messages`);
    const ins = await client.query(
      `INSERT INTO gdm_members (group_id, email, joined_from_id, added_by)
       SELECT $1, e, $2, $3 FROM unnest($4::text[]) AS e
       ON CONFLICT (group_id, email) DO NOTHING RETURNING email`,
      [gid, from.rows[0].m, me, add]
    );
    added = (ins.rows as { email: string }[]).map((r) => r.email);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (added.length > 0) {
    await emitGroupToMembers(gid);
    const names = await resolveDisplayNames([me, ...added]);
    await insertMessage(gid, null, "system", `${displayName(me, names)}が${namesLine(added, names)}を追加しました`);
  }
  const loaded = await loadGroup(gid);
  const lk = await lookup(loaded!.members.map((m) => m.email));
  return toGroupDto(loaded!.group, loaded!.members, me, lk);
}

/** 外す（作った人だけ）・抜ける（自分なら誰でも）。作った人が抜けたら、いちばん早く入った人へ。0 人ならグループを消す。 */
export async function removeMember(actor: DmActor, rawGid: unknown, rawUserId: unknown): Promise<{ ok: true }> {
  const { gid, group, members } = await requireMember(actor, rawGid);
  const me = normEmail(actor.email);
  if (!validPeerId(rawUserId)) throw new DmError(400, "invalid_request", "相手が不正です");
  let target: string | undefined;
  if (rawUserId === actor.userId) target = me;
  else {
    const r = await pool.query(`SELECT lower(email) AS email FROM users WHERE user_id = $1`, [rawUserId]);
    target = r.rows[0]?.email;
  }
  if (!target || !members.some((m) => normEmail(m.email) === target)) throw new DmError(404, "not_found", "メンバーが見つかりません");
  const self = target === me;
  if (!self && normEmail(group.creator_email) !== me) throw new DmError(403, "forbidden", "外せるのはグループを作った人だけです");

  // 削除・引き継ぎ・0 人で消すを、グループの行に鍵をかけてまとめて行う（同時に抜けても作った人が消えないように）。
  const client = await pool.connect();
  let gone = false;
  let g0photo: string | null = null;
  try {
    await client.query("BEGIN");
    const g = await client.query(`SELECT creator_email, photo FROM gdm_groups WHERE id = $1 FOR UPDATE`, [gid]);
    if (!g.rows[0]) throw new DmError(404, "not_found", "グループが見つかりません");
    g0photo = g.rows[0].photo ?? null;
    if (!self) {
      // 鍵を取ってから、外す権限を確かめ直す
      if (normEmail(g.rows[0].creator_email) !== me) throw new DmError(403, "forbidden", "外せるのはグループを作った人だけです");
    }
    const del = await client.query(`DELETE FROM gdm_members WHERE group_id = $1 AND email = $2`, [gid, target]);
    if (!del.rowCount) throw new DmError(404, "not_found", "メンバーが見つかりません");
    if (self) {
      await client.query(
        `INSERT INTO gdm_leaves (group_id, email, left_at) VALUES ($1, $2, now())
         ON CONFLICT (group_id, email) DO UPDATE SET left_at = now()`,
        [gid, target]
      );
    }
    const rest = await client.query(`SELECT email FROM gdm_members WHERE group_id = $1 ORDER BY joined_at, email LIMIT 1`, [gid]);
    if (!rest.rows[0]) {
      await client.query(`DELETE FROM gdm_groups WHERE id = $1`, [gid]);
      gone = true;
    } else if (normEmail(g.rows[0].creator_email) === target) {
      await client.query(`UPDATE gdm_groups SET creator_email = $2 WHERE id = $1`, [gid, normEmail(rest.rows[0].email)]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  emitPersonal(target, { type: "gdm", data: { action: "removed", group_id: gid } });
  if (gone) {
    await removePhotoFile(g0photo);
    return { ok: true };
  }
  const names = await resolveDisplayNames([me, target]);
  try {
    await insertMessage(
      gid,
      null,
      "system",
      self ? `${displayName(target, names)}が抜けました` : `${displayName(me, names)}が${displayName(target, names)}を外しました`
    );
    await emitGroupToMembers(gid);
  } catch (e) {
    // 同時に最後の人も抜けてグループが消えた（外部キー違反）。抜けること自体はできているので成功を返す。
    if ((e as { code?: string })?.code !== "23503") throw e;
  }
  return { ok: true };
}

/** 1 件（通知の本文を端末が読むとき）。メンバーでなければ（入る前の発言も）null。 */
export async function getGroupMessage(actor: DmActor, id: number): Promise<{ message: GMessageDto; group: GroupDto } | null> {
  const me = normEmail(actor.email);
  const r = await pool.query(
    `SELECT m.id, m.group_id, m.sender_email, m.kind, m.body, m.created_at
       FROM gdm_messages m JOIN gdm_members gm ON gm.group_id = m.group_id AND gm.email = $2
      WHERE m.id = $1 AND m.id > gm.joined_from_id AND m.created_at >= now() - ($3::text)::interval`,
    [id, me, DM_TTL]
  );
  const row = r.rows[0] as MsgRow | undefined;
  if (!row) return null;
  const loaded = await loadGroup(row.group_id);
  if (!loaded) return null;
  const lk = await lookup([...loaded.members.map((m) => m.email), ...(row.sender_email ? [row.sender_email] : [])]);
  return { message: toGMessageDto(row, me, lk), group: toGroupDto(loaded.group, loaded.members, me, lk) };
}

/** 30 日を過ぎた発言を消す（1 対 1 の掃除から呼ぶ）。 */
export async function purgeExpiredGdm(): Promise<number> {
  const r = await pool.query(`DELETE FROM gdm_messages WHERE created_at < now() - ($1::text)::interval`, [DM_TTL]);
  return r.rowCount ?? 0;
}

/** capabilities の features.gdm。 */
export function gdmCapability(enabled: boolean, scopes: string[]) {
  return {
    enabled,
    path: "/api/agent/gdm",
    send: enabled && scopes.includes("chat"),
    max_body: DM_MAX_BODY,
    max_name: GDM_MAX_NAME,
    max_members: GDM_MAX_MEMBERS,
    ttl_hours: DM_TTL_HOURS,
    rate_limit_per_hour: 60,
    // グループの写真: POST/DELETE {path}/:gid/photo（multipart の photo）。読むのは DTO の photo（鍵の Bearer）。
    photo: true,
    photo_max_bytes: GDM_PHOTO_MAX_BYTES,
    // stream: event "gdm" — { action: "create" | "read" | "group" | "removed", ... }（docs/group-dm-spec.md）
    stream_event: "gdm",
  };
}

// ---- グループの写真（docs/group-dm-spec.md）----
// 変えられるのはメンバーなら誰でも（名前と同じ）。正方形 512px の WebP にし、位置情報などは落とす。
// 置き場所は data/gdm-photos（public の外。/api/media からは読めない）。30 日では消さず、グループが消えるときに消す。

export const GDM_PHOTO_SIDE = 512;
export const GDM_PHOTO_MAX_BYTES = 15 * 1024 * 1024;
/** 1 枚の画素数の上限（512px のアイコンには十分。画像爆弾よけ）。 */
const GDM_PHOTO_MAX_PIXELS = 40_000_000;

/** 写真を受け取る前の確かめ（本文を読む前に、メンバーか・使えるかを見る）。 */
export async function assertCanSetPhoto(actor: DmActor, rawGid: unknown): Promise<void> {
  if (!gdmEnabledFor(actor.email)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  await requireMember(actor, rawGid);
}
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const PHOTO_FILE_RE = /^g\d+-[a-f0-9]{16}\.webp$/;

export function gdmPhotoDir(): string {
  return process.env.GDM_PHOTO_DIR || path.join(process.cwd(), "data", "gdm-photos");
}

async function removePhotoFile(file: string | null | undefined): Promise<void> {
  if (!file || !PHOTO_FILE_RE.test(file)) return;
  await rm(path.join(gdmPhotoDir(), file), { force: true }).catch(() => {});
}

/** 写真を設定する（取り替えも）。返り値は見る人から見たグループ。 */
export async function setGroupPhoto(actor: DmActor, rawGid: unknown, data: Buffer, mime: string): Promise<GroupDto> {
  const me = normEmail(actor.email);
  if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  const { gid } = await requireMember(actor, rawGid);
  if (!PHOTO_TYPES.has((mime || "").toLowerCase())) throw new DmError(400, "invalid_request", "JPEG・PNG・WebP の写真を選んでください");
  if (data.length === 0 || data.length > GDM_PHOTO_MAX_BYTES) throw new DmError(400, "invalid_request", "写真が大きすぎます");
  await checkAdminRate(me);
  let out: Buffer;
  try {
    out = await withImageSlot(async () => {
      // 形式は送り手の申告（Content-Type）ではなく中身で確かめる（SVG・PDF・多ページの形式を解かさない）
      const meta = await sharp(data, { limitInputPixels: GDM_PHOTO_MAX_PIXELS }).metadata();
      if (!["jpeg", "png", "webp", "heif"].includes(meta.format ?? "") || (meta.pages ?? 1) > 1) throw new Error("format");
      return sharp(data, { autoOrient: true, failOn: "error", limitInputPixels: GDM_PHOTO_MAX_PIXELS })
        .resize(GDM_PHOTO_SIDE, GDM_PHOTO_SIDE, { fit: "cover", position: "attention" })
        .keepIccProfile() // 色だけは残す（位置情報などのメタデータは既定で落ちる）
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
    });
  } catch {
    throw new DmError(400, "invalid_request", "この写真は読めませんでした");
  }
  const file = `g${gid}-${crypto.randomBytes(8).toString("hex")}.webp`;
  await mkdir(gdmPhotoDir(), { recursive: true });
  await writeFile(path.join(gdmPhotoDir(), file), out);
  // 前のファイル名は同じクエリで取る（同時の取り替えでファイルが残らないように）
  const r = await pool.query(
    `UPDATE gdm_groups g SET photo = $2, updated_at = now()
       FROM (SELECT id, photo FROM gdm_groups WHERE id = $1 FOR UPDATE) old
      WHERE g.id = old.id RETURNING old.photo AS prev`,
    [gid, file]
  );
  if (!r.rowCount) {
    await removePhotoFile(file); // 同時にグループが消えた
    throw new DmError(404, "not_found", "グループが見つかりません");
  }
  await removePhotoFile(r.rows[0]?.prev);
  return afterPhotoChange(actor, gid, "グループの写真を変えました");
}

/** 写真を外す。 */
export async function removeGroupPhoto(actor: DmActor, rawGid: unknown): Promise<GroupDto> {
  const me = normEmail(actor.email);
  if (!gdmEnabledFor(me)) throw new DmError(403, "forbidden", "グループ DM はまだ使えません");
  const { gid, group } = await requireMember(actor, rawGid);
  if (!group.photo) {
    const loaded = (await loadGroup(gid))!;
    return toGroupDto(loaded.group, loaded.members, me, await lookup(loaded.members.map((m) => m.email)));
  }
  await checkAdminRate(me);
  await pool.query(`UPDATE gdm_groups SET photo = NULL, updated_at = now() WHERE id = $1`, [gid]);
  await removePhotoFile(group.photo);
  return afterPhotoChange(actor, gid, "グループの写真を外しました");
}

async function afterPhotoChange(actor: DmActor, gid: number, what: string): Promise<GroupDto> {
  const me = normEmail(actor.email);
  const names = await resolveDisplayNames([me]);
  await emitGroupToMembers(gid);
  await insertMessage(gid, null, "system", `${displayName(me, names)}が${what}`);
  const loaded = await loadGroup(gid);
  const lk = await lookup(loaded!.members.map((m) => m.email));
  return toGroupDto(loaded!.group, loaded!.members, me, lk);
}

/** 写真のファイルを読む（メンバーだけ）。無ければ null。 */
export async function readGroupPhoto(email: string, rawGid: unknown): Promise<Buffer | null> {
  const gid = parseGroupId(rawGid);
  const r = await pool.query(
    `SELECT g.photo FROM gdm_groups g JOIN gdm_members gm ON gm.group_id = g.id AND gm.email = $2 WHERE g.id = $1`,
    [gid, normEmail(email)]
  );
  const file = r.rows[0]?.photo as string | undefined;
  if (!file || !PHOTO_FILE_RE.test(file)) return null;
  try {
    return await readFile(path.join(gdmPhotoDir(), file));
  } catch {
    return null;
  }
}
