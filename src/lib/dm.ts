/* ✉️ 簡易 DM — 有料会員どうしの 1 対 1。テキストだけ、24 時間で消える（チャットと同じ考え方）。
 *
 *   - 表は dm_messages / dm_read_state（db.ts）。chat_messages は使わない。
 *   - 読めるのは当事者 2 人だけ。送り主は常にサーバの認証（セッション / アプリの鍵）から決める
 *     （クライアントが送ってくる「誰から」は一切信じない）。
 *   - 応答・配信の DTO にメールは入れない（相手は users.user_id。lib/agent-chat.ts と同じ決まり）。
 *   - 送信は 1 人あたり 1 時間 60 件まで（Web とアプリで共通のカウンタ）、本文はチャットと同じ上限。
 *   - 届いたら相手に通知（push-notify.ts の pushDm）、両者の配信（personal-live.ts）に流す。
 *   - DM_ENABLED（feature-flag.ts と同じ書き方）で出す人を決める。相手も対象でないと送れない。
 * ブロック・通報・受け取らない設定は持たない（オーナー決定 2026-10-24）。 */
import { pool } from "./db";
import { gravatarUrl, SYSTEM_EMAIL } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emailToUserIds, userIdToEmail } from "./user";
import { CHAT_BODY_LIMIT } from "./chat-optimistic";
import { featureEnabledFor } from "./feature-flag";
import { emitPersonal } from "./personal-live";
import { pushDm } from "./push-notify";

export const DM_FLAG = "DM_ENABLED";
export function dmEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor(DM_FLAG, email);
}

/** DM は送ってからこの時間で消える。 */
export const DM_TTL = "24 hours";
export const DM_TTL_HOURS = 24;
/** 本文の上限（チャットと同じ）。 */
export const DM_MAX_BODY = CHAT_BODY_LIMIT;
/** 送信の上限（1 人あたり）。 */
export const DM_RATE_LIMIT = 60;
export const DM_RATE_WINDOW = "1 hour";
/** 1 回に返す会話の件数の上限。 */
export const DM_PAGE_LIMIT = 200;
/** 会話の一覧の上限。 */
export const DM_CONVERSATIONS_LIMIT = 100;

export class DmError extends Error {
  constructor(
    public status: number,
    public code: "invalid_request" | "not_found" | "forbidden" | "rate_limited",
    message: string,
    public retryAfter?: number
  ) {
    super(message);
  }
}

/** 認証済みの本人（Web: セッション、アプリ: 鍵）。 */
export type DmActor = { email: string; userId: string };

export type DmPeer = { user_id: string; name: string | null; avatar: string | null };

export type DmMessageDto = {
  id: number;
  /** 送った人・受け取った人（users.user_id）。 */
  from_id: string;
  to_id: string;
  /** この DTO を見る人から見た相手（会話の鍵）。 */
  peer_id: string;
  body: string;
  created_at: string;
  /** 見る人が送ったものか。 */
  is_author: boolean;
  /** 送った本人の端末にだけ返す（楽観的に出した吹き出しと突き合わせる）。 */
  client_id?: string;
};

export type DmConversationDto = {
  peer: DmPeer;
  last_message: DmMessageDto;
  unread_count: number;
};

type DmRow = {
  id: number;
  sender_email: string;
  recipient_email: string;
  body: string;
  created_at: Date | string;
};

export function normEmail(e: string): string {
  return (e || "").trim().toLowerCase();
}

/** 本文の正規化と検証（チャットと同じ: 改行をそろえ、前後の空白を落とし、空・長すぎは不可）。 */
export function normalizeDmBody(raw: unknown): { ok: true; body: string } | { ok: false; error: "empty" | "too long" } {
  const body = (typeof raw === "string" ? raw : "").replace(/\r\n/g, "\n").trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > DM_MAX_BODY) return { ok: false, error: "too long" };
  return { ok: true, body };
}

/** users.user_id の形（12 文字の英数字。少し広めに受ける）。 */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function validPeerId(v: unknown): v is string {
  return typeof v === "string" && USER_ID_RE.test(v);
}

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function normalizeDmClientId(v: unknown): string | null {
  return typeof v === "string" && CLIENT_ID_RE.test(v) ? v : null;
}

/** 行 → 見る人ごとの DTO（純粋関数）。ids: email → user_id。 */
export function toDmDto(r: DmRow, viewerEmail: string, ids: Map<string, string>, clientId?: string | null): DmMessageDto {
  const from = normEmail(r.sender_email);
  const to = normEmail(r.recipient_email);
  const mine = from === normEmail(viewerEmail);
  const fromId = ids.get(from) ?? "";
  const toId = ids.get(to) ?? "";
  const dto: DmMessageDto = {
    id: r.id,
    from_id: fromId,
    to_id: toId,
    peer_id: mine ? toId : fromId,
    body: r.body,
    created_at: new Date(r.created_at).toISOString(),
    is_author: mine,
  };
  if (mine && clientId) dto.client_id = clientId;
  return dto;
}

export function peerDto(email: string, userId: string, names: Map<string, string | null>): DmPeer {
  return { user_id: userId, name: names.get(email) ?? null, avatar: gravatarUrl(email) };
}

/** 相手の user_id → 相手（自分・B-guru・知らない人は不可）。 */
async function resolvePeer(actor: DmActor, peerId: unknown): Promise<{ email: string; userId: string }> {
  if (!validPeerId(peerId)) throw new DmError(400, "invalid_request", "相手が不正です");
  const email = await userIdToEmail(peerId);
  if (!email || normEmail(email) === SYSTEM_EMAIL) throw new DmError(404, "not_found", "相手が見つかりません");
  if (normEmail(email) === normEmail(actor.email) || peerId === actor.userId) {
    throw new DmError(400, "invalid_request", "自分には送れません");
  }
  return { email: normEmail(email), userId: peerId };
}

/** 相手がいま会員としてログインしているか（有効なセッションか、失効していないアプリの鍵がある）。
 *  会員が終わると鍵は失効し（agent-auth.ts）、セッションも切れるので、これを会員の目印にする。 */
export async function isActiveMember(email: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM sessions WHERE lower(email) = $1 AND expires_at > now())
         OR EXISTS (SELECT 1 FROM agent_tokens WHERE lower(email) = $1 AND revoked_at IS NULL AND expires_at > now()) AS ok`,
    [normEmail(email)]
  );
  return !!r.rows[0]?.ok;
}

/** 送信の回数制限（1 人あたり・固定窓。rate_limits を共用、鍵は dm:<email>）。 */
export async function checkDmRate(email: string): Promise<{ allowed: boolean; retryAfter: number }> {
  const res = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                           THEN now() ELSE rate_limits.window_start END,
       count = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                    THEN 1 ELSE rate_limits.count + 1 END
     RETURNING count, window_start`,
    [`dm:${normEmail(email)}`, DM_RATE_WINDOW]
  );
  const count = Number(res.rows[0].count);
  if (count <= DM_RATE_LIMIT) return { allowed: true, retryAfter: 0 };
  const started = new Date(res.rows[0].window_start).getTime();
  return { allowed: false, retryAfter: Math.max(1, Math.ceil((started + 3600_000 - Date.now()) / 1000)) };
}

/** 未読の合計（自分宛てで、相手ごとの既読より新しく、24 時間以内）。 */
export async function getDmUnreadTotal(email: string): Promise<number> {
  const me = normEmail(email);
  const r = await pool.query(
    `SELECT count(*)::int AS c
       FROM dm_messages m
       LEFT JOIN dm_read_state s ON s.email = $1 AND s.peer_email = m.sender_email
      WHERE m.recipient_email = $1
        AND m.created_at >= now() - ($2::text)::interval
        AND m.id > COALESCE(s.last_read_id, 0)`,
    [me, DM_TTL]
  );
  return r.rows[0]?.c ?? 0;
}

/** 会話の一覧（新しい順）と未読の合計。 */
export async function listDmConversations(actor: DmActor): Promise<{ conversations: DmConversationDto[]; unread_count: number }> {
  const me = normEmail(actor.email);
  const r = await pool.query(
    `WITH mine AS (
       SELECT id, sender_email, recipient_email, body, created_at,
              CASE WHEN sender_email = $1 THEN recipient_email ELSE sender_email END AS peer
         FROM dm_messages
        WHERE (sender_email = $1 OR recipient_email = $1)
          AND created_at >= now() - ($2::text)::interval
     ), last AS (
       SELECT DISTINCT ON (peer) * FROM mine ORDER BY peer, id DESC
     ), unread AS (
       SELECT m.peer, count(*)::int AS c
         FROM mine m
         LEFT JOIN dm_read_state s ON s.email = $1 AND s.peer_email = m.peer
        WHERE m.recipient_email = $1 AND m.id > COALESCE(s.last_read_id, 0)
        GROUP BY m.peer
     )
     SELECT last.*, COALESCE(unread.c, 0)::int AS unread
       FROM last LEFT JOIN unread ON unread.peer = last.peer
      ORDER BY last.id DESC
      LIMIT $3`,
    [me, DM_TTL, DM_CONVERSATIONS_LIMIT]
  );
  const rows = r.rows as (DmRow & { peer: string; unread: number })[];
  const emails = [me, ...rows.map((x) => x.peer)];
  const [ids, names] = await Promise.all([emailToUserIds(emails), resolveDisplayNames(rows.map((x) => x.peer))]);
  const conversations: DmConversationDto[] = [];
  let total = 0;
  for (const row of rows) {
    const peerId = ids.get(row.peer);
    if (!peerId) continue; // user_id の無い相手（ありえないが、出さない）
    total += row.unread;
    conversations.push({
      peer: peerDto(row.peer, peerId, names),
      last_message: toDmDto(row, me, ids),
      unread_count: row.unread,
    });
  }
  return { conversations, unread_count: total };
}

/** 1 つの会話（古い→新しい、24 時間以内）。読むのは当事者だけ（自分が入っている行しか引かない）。 */
export async function listDmMessages(
  actor: DmActor,
  peerId: unknown,
  opts: { before?: number; limit?: number } = {}
): Promise<{ peer: DmPeer; messages: DmMessageDto[]; unread_count: number; last_read_id: number; can_send: boolean }> {
  const peer = await resolvePeer(actor, peerId);
  const me = normEmail(actor.email);
  const limit = Math.min(Math.max(opts.limit ?? DM_PAGE_LIMIT, 1), DM_PAGE_LIMIT);
  const [res, read, names, canSend] = await Promise.all([
    pool.query(
      `SELECT id, sender_email, recipient_email, body, created_at
         FROM dm_messages
        WHERE ((sender_email = $1 AND recipient_email = $2) OR (sender_email = $2 AND recipient_email = $1))
          AND created_at >= now() - ($3::text)::interval
          AND ($4::int IS NULL OR id < $4)
        ORDER BY id DESC
        LIMIT $5`,
      [me, peer.email, DM_TTL, opts.before ?? null, limit]
    ),
    pool.query(`SELECT last_read_id FROM dm_read_state WHERE email = $1 AND peer_email = $2`, [me, peer.email]),
    resolveDisplayNames([peer.email]),
    peerCanReceive(peer.email),
  ]);
  const ids = new Map<string, string>([
    [me, actor.userId],
    [peer.email, peer.userId],
  ]);
  const rows = (res.rows as DmRow[]).reverse();
  const lastRead = Number(read.rows[0]?.last_read_id ?? 0);
  const messages = rows.map((r) => toDmDto(r, me, ids));
  const unread = messages.filter((m) => !m.is_author && m.id > lastRead).length;
  return { peer: peerDto(peer.email, peer.userId, names), messages, unread_count: unread, last_read_id: lastRead, can_send: canSend };
}

async function peerCanReceive(email: string): Promise<boolean> {
  if (!dmEnabledFor(email)) return false;
  return isActiveMember(email);
}

/** 1 件（通知の本文を端末が読むとき）。当事者でなければ null。 */
export async function getDmMessage(actor: DmActor, id: number): Promise<{ message: DmMessageDto; peer: DmPeer } | null> {
  const me = normEmail(actor.email);
  const r = await pool.query(
    `SELECT id, sender_email, recipient_email, body, created_at
       FROM dm_messages
      WHERE id = $1 AND (sender_email = $2 OR recipient_email = $2)
        AND created_at >= now() - ($3::text)::interval`,
    [id, me, DM_TTL]
  );
  const row = r.rows[0] as DmRow | undefined;
  if (!row) return null;
  const peerEmail = normEmail(row.sender_email) === me ? normEmail(row.recipient_email) : normEmail(row.sender_email);
  const [ids, names] = await Promise.all([emailToUserIds([me, peerEmail]), resolveDisplayNames([peerEmail])]);
  ids.set(me, actor.userId);
  const peerId = ids.get(peerEmail);
  if (!peerId) return null;
  return { message: toDmDto(row, me, ids), peer: peerDto(peerEmail, peerId, names) };
}

/** 既読を進める（単調）。自分のほかの端末にも知らせる。返り値は未読の合計。 */
export async function markDmRead(actor: DmActor, peerId: unknown, lastReadId: unknown): Promise<{ unread_count: number }> {
  const peer = await resolvePeer(actor, peerId);
  const n = Number(lastReadId);
  if (!Number.isInteger(n) || n < 0 || n > 2147483647) throw new DmError(400, "invalid_request", "last_read_id が不正です");
  const me = normEmail(actor.email);
  await pool.query(
    `INSERT INTO dm_read_state (email, peer_email, last_read_id, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (email, peer_email) DO UPDATE SET
       last_read_id = GREATEST(dm_read_state.last_read_id, EXCLUDED.last_read_id),
       updated_at = now()`,
    [me, peer.email, n]
  );
  const unread = await getDmUnreadTotal(me);
  emitPersonal(me, { type: "dm", data: { action: "read", peer_id: peer.userId, last_read_id: n, unread_count: unread } });
  return { unread_count: unread };
}

/** 同じ client_id の再送（応答が届かなかった）を 2 重に入れない（chat.ts の sendChatMessage と同じ考え方）。 */
const SEND_DEDUP_TTL_MS = 10 * 60_000;
const SEND_DEDUP_MAX = 2000;
const recentSends = new Map<string, { at: number; p: Promise<DmMessageDto> }>();

/** 送る。返り値は送り主から見た DTO。 */
export async function sendDm(actor: DmActor, peerId: unknown, rawBody: unknown, rawClientId: unknown = null): Promise<DmMessageDto> {
  const checked = normalizeDmBody(rawBody);
  if (!checked.ok) {
    throw new DmError(400, "invalid_request", checked.error === "empty" ? "本文が空です" : `本文が長すぎます（${DM_MAX_BODY} 文字まで）`);
  }
  const clientId = normalizeDmClientId(rawClientId);
  if (!clientId) return insertDm(actor, peerId, checked.body, null);
  const now = Date.now();
  for (const [k, v] of recentSends) {
    if (recentSends.size <= SEND_DEDUP_MAX && now - v.at < SEND_DEDUP_TTL_MS) break;
    recentSends.delete(k);
  }
  const key = `${normEmail(actor.email)}\u0000${clientId}`;
  const hit = recentSends.get(key);
  if (hit && now - hit.at < SEND_DEDUP_TTL_MS) return { ...(await hit.p) };
  const p = insertDm(actor, peerId, checked.body, clientId);
  recentSends.set(key, { at: now, p });
  try {
    return await p;
  } catch (e) {
    recentSends.delete(key);
    throw e;
  }
}

async function insertDm(actor: DmActor, peerId: unknown, body: string, clientId: string | null): Promise<DmMessageDto> {
  const me = normEmail(actor.email);
  if (!dmEnabledFor(me)) throw new DmError(403, "forbidden", "DM はまだ使えません");
  const peer = await resolvePeer(actor, peerId);
  if (!(await peerCanReceive(peer.email))) throw new DmError(403, "forbidden", "この人にはまだ DM を送れません");
  const rate = await checkDmRate(me);
  if (!rate.allowed) throw new DmError(429, "rate_limited", "DM を送りすぎです。しばらく待ってください", rate.retryAfter);

  const ins = await pool.query(
    `INSERT INTO dm_messages (sender_email, recipient_email, body) VALUES ($1, $2, $3)
     RETURNING id, sender_email, recipient_email, body, created_at`,
    [me, peer.email, body]
  );
  const row = ins.rows[0] as DmRow;
  const ids = new Map<string, string>([
    [me, actor.userId],
    [peer.email, peer.userId],
  ]);
  // 送ったら、その会話はそこまで見たことにする。
  await pool
    .query(
      `INSERT INTO dm_read_state (email, peer_email, last_read_id, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (email, peer_email) DO UPDATE SET last_read_id = GREATEST(dm_read_state.last_read_id, EXCLUDED.last_read_id), updated_at = now()`,
      [me, peer.email, row.id]
    )
    .catch((e) => console.error("dm read after send:", (e as Error)?.message));

  const mine = toDmDto(row, me, ids, clientId);
  const names = await resolveDisplayNames([me, peer.email]).catch(() => new Map<string, string | null>());
  // 送り主のほかの端末（client_id つき）と、相手（未読の合計つき）へ。
  emitPersonal(me, { type: "dm", data: { action: "create", message: mine, peer: peerDto(peer.email, peer.userId, names) } });
  void (async () => {
    const unread = await getDmUnreadTotal(peer.email).catch(() => null);
    emitPersonal(peer.email, {
      type: "dm",
      data: {
        action: "create",
        message: toDmDto(row, peer.email, ids),
        peer: peerDto(me, actor.userId, names),
        ...(unread != null ? { unread_count: unread } : {}),
      },
    });
  })();
  void pushDm(peer.email, row.id, actor.userId).catch((e) => console.error("dm push:", (e as Error)?.message));
  return mine;
}

/** 24 時間を過ぎた DM と、それより古い既読の記録を消す。消した DM の件数を返す。 */
export async function purgeExpiredDm(): Promise<number> {
  const r = await pool.query(`DELETE FROM dm_messages WHERE created_at < now() - ($1::text)::interval`, [DM_TTL]);
  // 既読の記録は、最後に動いてから 25 時間たてば指している DM はもう残っていない（消しても未読は変わらない）。
  await pool.query(`DELETE FROM dm_read_state WHERE updated_at < now() - interval '25 hours'`);
  return r.rowCount ?? 0;
}

let dmSweeperStarted = false;
/** 1 プロセスに 1 つの掃除（ensureChatSweeper と同じ形）。DM は時刻で消えるので、配信はしない
 *  （クライアントも 24 時間を過ぎたものは自分で隠す）。 */
export function ensureDmSweeper(): void {
  if (dmSweeperStarted) return;
  dmSweeperStarted = true;
  setInterval(async () => {
    try {
      await purgeExpiredDm();
    } catch (e) {
      console.error("dm sweeper error:", (e as Error)?.message);
    }
  }, 60_000);
}

/** capabilities の features.dm。 */
export function dmCapability(enabled: boolean, scopes: string[]) {
  return {
    enabled,
    path: "/api/agent/dm",
    send: enabled && scopes.includes("chat"),
    max_body: DM_MAX_BODY,
    ttl_hours: DM_TTL_HOURS,
    rate_limit_per_hour: DM_RATE_LIMIT,
    // stream: event "dm" — { action: "create", message, peer, unread_count? } / { action: "read", peer_id, last_read_id, unread_count }
    stream_event: "dm",
  };
}
