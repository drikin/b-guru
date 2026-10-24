/* Realtime community chat — a single global room for lightweight,
 * back-and-forth between online members. Persisted so history can be
 * re-loaded when the bubble panel is opened, with a per-user read cursor
 * driving the unread badge on the bubble.
 *
 * This is the "ephemeral chat" counterpart to the timeline: chat messages
 * live in `chat_messages` and never appear in the feed.
 */
import { readdir, rm, stat } from "fs/promises";
import path from "path";
import { pool } from "./db";
import { gravatarUrl, SYSTEM_EMAIL } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emailToUserId, emailToUserIds } from "./user";
import { emitLive } from "./live";
import { CHAT_BODY_LIMIT } from "./chat-optimistic";
import { pushChatMessage } from "./push-notify";

/**
 * A chat message as serialized to the client.
 *
 * `authorId` is the opaque public identifier. `isAuthor` is per-VIEWER and is
 * therefore only meaningful on a response to one client — it must never be put
 * on an SSE broadcast, which is fanned out to everyone (see live.ts).
 */
export interface ChatMessage {
  id: number;
  authorId: string | null;
  isAuthor: boolean;
  authorName: string | null;
  body: string;
  createdAt: string; // ISO timestamp
  avatar: string | null;
  edited: boolean; // author corrected a typo after posting
  editedAt: string | null; // ISO timestamp of the edit
  /** Attached photos (/api/media/chat-…), at most CHAT_MAX_IMAGES. */
  images?: string[];
  /** "notice": a quiet one-line note from B-guru (room comings and goings).
   *  "shogi": the ☗ 将棋 game card (lib/shogi.ts) — `shogiGameId` says which game. Its body
   *  is plain text that reads fine on its own, so clients that do not know it show a line. */
  kind?: "notice" | "shogi" | "beagle_ai" | null;
  /** kind "beagle_ai": the question this answers (lib/beagle-ondevice.ts). */
  replyToId?: number;
  shogiGameId?: number;
  /** Only on the create event / POST response of the sender's own message:
   *  the client-generated id of the optimistic bubble it replaces. */
  clientId?: string;
}

/** Max body length for a chat message (shared with the composer). */
export const CHAT_MAX_BODY = CHAT_BODY_LIMIT;
/** Default page size returned by GET /api/chat. */
export const CHAT_PAGE_SIZE = 50;
/** Chat messages are ephemeral: each one disappears this long after posting. */
export const CHAT_TTL = "24 hours";

/** Delete chat messages older than the TTL and return the removed ids so they
 *  can be broadcast over SSE (open chat panels remove them live). */
export async function purgeExpiredChat(): Promise<number[]> {
  const res = await pool.query(
    `DELETE FROM chat_messages
     WHERE created_at < now() - ($1::text)::interval
     RETURNING id`,
    [CHAT_TTL]
  );
  // The on-device Beagle's record of who posted what (lib/beagle-ondevice.ts) is kept 30 days.
  await pool.query(`DELETE FROM beagle_ai_log WHERE created_at < now() - interval '30 days'`);
  return res.rows.map((r) => r.id);
}

/** Start a single process-wide sweeper that removes expired chat messages and
 *  broadcasts each removal over SSE. Idempotent (mirrors ensurePresenceSweeper). */
let chatSweeperStarted = false;
export function ensureChatSweeper(): void {
  if (chatSweeperStarted) return;
  chatSweeperStarted = true;
  setInterval(async () => {
    try {
      const ids = await purgeExpiredChat();
      for (const id of ids) {
        emitLive({ type: "chat", action: "delete", message: { id } });
      }
      await purgeExpiredChatFiles();
    } catch (e) {
      console.error("chat sweeper error:", (e as any)?.message);
    }
  }, 60_000);
}

/** Map a chat_messages row into the API shape. `viewerEmail` decides `isAuthor`. */
async function mapRow(
  r: {
    id: number;
    author_email: string;
    author_name: string | null;
    body: string;
    edited: boolean;
    reply_to_id?: number | null;
    edited_at: Date | string | null;
    created_at: Date | string;
    images?: string[] | null;
    kind?: string | null;
    shogi_game_id?: number | null;
  },
  viewerEmail: string | null,
  authorId: string | null
): Promise<ChatMessage> {
  return {
    id: r.id,
    authorId: authorId ?? "",
    isAuthor: viewerEmail != null && r.author_email === viewerEmail,
    authorName: r.author_name,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    avatar: gravatarUrl(r.author_email),
    edited: r.edited,
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
    images: r.images ?? [],
    ...(r.kind === "notice" ? { kind: "notice" as const } : {}),
    ...(r.kind === "shogi" && r.shogi_game_id ? { kind: "shogi" as const, shogiGameId: r.shogi_game_id } : {}),
    ...(r.kind === "beagle_ai" ? { kind: "beagle_ai" as const, ...(r.reply_to_id ? { replyToId: r.reply_to_id } : {}) } : {}),
  };
}

/** mapRow for other chat writers (lib/beagle-ondevice.ts). */
export const mapChatRow = mapRow;

/** Recent chat history, oldest→newest for natural reading order. */
export async function listChatMessages(opts: {
  before?: number;
  limit?: number;
  viewerEmail?: string | null;
} = {}): Promise<ChatMessage[]> {
  const limit = Math.min(opts.limit ?? CHAT_PAGE_SIZE, 200);
  const res = await pool.query(
    `SELECT * FROM chat_messages
     WHERE ($1::int IS NULL OR id < $1)
       AND created_at >= now() - ($2::text)::interval
     ORDER BY id DESC
     LIMIT $3`,
    [opts.before ?? null, CHAT_TTL, limit]
  );
  // Reverse so the returned array is chronological (oldest first).
  const rows = res.rows.reverse();
  // Resolve each author's CURRENT display name at read time so profile
  // display_name edits propagate to historical messages too.
  const names = await resolveDisplayNames(rows.map((r) => r.author_email));
  const ids = await emailToUserIds(rows.map((r) => r.author_email));
  const viewerEmail = opts.viewerEmail ?? null;
  return Promise.all(
    rows.map(async (r) => {
      const m = await mapRow(
        r,
        viewerEmail,
        ids.get(r.author_email?.trim().toLowerCase()) ?? null
      );
      const resolved = names.get(r.author_email) ?? null;
      // The on-device Beagle's name says whose device made it: kept as written.
      if (resolved && r.kind !== "beagle_ai") m.authorName = resolved;
      return m;
    })
  );
}

/** A quiet one-line note from B-guru (kind "notice"), or an update of one (several
 *  comings and goings gathered into one line). Broadcast like any chat message. */
export async function postChatNotice(
  body: string,
  updateId: number | null = null,
  /** トランザクションの中で入れるとき（将棋の実況の見どころ: 対局の行をロックしたまま入れる）。 */
  db: Pick<typeof pool, "query"> = pool
): Promise<ChatMessage | null> {
  const res = updateId
    ? await db.query(
        `UPDATE chat_messages SET body = $1 WHERE id = $2 AND kind = 'notice'
         RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind`,
        [body, updateId]
      )
    : await db.query(
        `INSERT INTO chat_messages (author_email, author_name, body, kind) VALUES ($1, 'B-guru', $2, 'notice')
         RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind`,
        [SYSTEM_EMAIL, body]
      );
  const row = res.rows[0];
  if (!row) return null;
  const message = await mapRow(row, null, await emailToUserId(SYSTEM_EMAIL));
  const { isAuthor: _perReceiver, ...broadcast } = message;
  emitLive({ type: "chat", message: broadcast, action: updateId ? "edit" : "create" });
  return message;
}

/** The ☗ 将棋 game card (kind "shogi"): one line when a game starts, its body rewritten
 *  with the result when it ends (`updateId`). Never per move. Broadcast like any chat
 *  message (create / edit); no push, no unread (same as a notice). */
export async function postShogiCard(body: string, gameId: number, updateId: number | null = null): Promise<ChatMessage | null> {
  const res = updateId
    ? await pool.query(
        `UPDATE chat_messages SET body = $1 WHERE id = $2 AND kind = 'shogi'
         RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind, shogi_game_id`,
        [body, updateId]
      )
    : await pool.query(
        `INSERT INTO chat_messages (author_email, author_name, body, kind, shogi_game_id) VALUES ($1, 'B-guru', $2, 'shogi', $3)
         RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind, shogi_game_id`,
        [SYSTEM_EMAIL, body, gameId]
      );
  const row = res.rows[0];
  if (!row) return null;
  const message = await mapRow(row, null, await emailToUserId(SYSTEM_EMAIL));
  const { isAuthor: _perReceiver, ...broadcast } = message;
  emitLive({ type: "chat", message: broadcast, action: updateId ? "edit" : "create" });
  return message;
}

/** Insert a new chat message. Returns the created message. */
export async function createChatMessage(
  email: string,
  name: string | null,
  body: string,
  viewerEmail: string | null = email
): Promise<ChatMessage> {
  const res = await pool.query(
    `INSERT INTO chat_messages (author_email, author_name, body)
     VALUES ($1, $2, $3)
     RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind`,
    [email, name, body]
  );
  return mapRow(res.rows[0], viewerEmail, await emailToUserId(email));
}

/** Client-generated id echoed back on the create event so an optimistic
 *  (pending) bubble can be matched to the stored message. Opaque, short. */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeClientId(v: unknown): string | null {
  return typeof v === "string" && CLIENT_ID_RE.test(v) ? v : null;
}

/** Photos per chat message. */
export const CHAT_MAX_IMAGES = 4;
/** Only photos uploaded for the chat (/api/chat/upload, /api/agent/chat/upload). */
export const CHAT_IMAGE_RE = /^\/api\/media\/chat-[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/;

/** Body + photos of a message to send. A message may be photos only (empty body).
 *  Shared by the web route and the agent API so both accept exactly the same input. */
export function normalizeChatInput(
  rawBody: unknown,
  rawImages: unknown
): { ok: true; body: string; images: string[] } | { ok: false; error: "empty" | "too long" | "bad images" } {
  const images = rawImages == null ? [] : Array.isArray(rawImages) ? rawImages : null;
  if (!images || images.length > CHAT_MAX_IMAGES || images.some((u) => typeof u !== "string" || !CHAT_IMAGE_RE.test(u))) {
    return { ok: false, error: "bad images" };
  }
  const body = normalizeChatBody(rawBody);
  if (body.ok) return { ok: true, body: body.body, images: [...new Set(images as string[])] };
  if (body.error === "empty" && images.length > 0) return { ok: true, body: "", images: [...new Set(images as string[])] };
  return body;
}

/** Normalize + validate a chat body. Shared by the web route and the agent
 *  API so both reject exactly the same input. */
export function normalizeChatBody(
  raw: unknown
): { ok: true; body: string } | { ok: false; error: "empty" | "too long" } {
  const body = (typeof raw === "string" ? raw : String(raw ?? ""))
    .replace(/\r\n/g, "\n")
    .trim();
  if (!body) return { ok: false, error: "empty" };
  if (body.length > CHAT_MAX_BODY) return { ok: false, error: "too long" };
  return { ok: true, body };
}

/** Recent sends by (email, clientId) → the stored message (or the in-flight
 *  insert), so a retry after a lost response — the INSERT happened, the reply
 *  never arrived — returns the same message instead of posting it twice, and
 *  two concurrent sends of one clientId share one insert. In-memory is enough:
 *  single long-lived process, and a retry comes within seconds. */
const SEND_DEDUP_TTL_MS = 10 * 60_000;
const SEND_DEDUP_MAX = 2000;
const recentSends = new Map<string, { at: number; p: Promise<ChatMessage> }>();

function pruneRecentSends(now: number): void {
  for (const [k, v] of recentSends) {
    // Map iterates oldest-first: stop at the first entry that is fresh and fits.
    if (recentSends.size <= SEND_DEDUP_MAX && now - v.at < SEND_DEDUP_TTL_MS) break;
    recentSends.delete(k);
  }
}

/**
 * Send path shared by POST /api/chat and POST /api/agent/chat.
 *
 * Latency matters more than anything for chat, so this is ONE round-trip:
 * display-name resolution (same rule as resolveDisplayNames + cleanDisplayName),
 * the INSERT and the author's user_id lookup all happen in a single statement.
 * The sender's read cursor is advanced without blocking the response (posting
 * means you have seen the room), and the message is broadcast over SSE with
 * the optional `clientId` so the sender's pending bubble can be reconciled.
 *
 * Returns the message as seen by the sender (isAuthor = true).
 */
export async function sendChatMessage(
  email: string,
  body: string,
  clientId: string | null = null,
  images: string[] = []
): Promise<ChatMessage> {
  if (!clientId) return insertAndBroadcast(email, body, null, images);
  const now = Date.now();
  pruneRecentSends(now);
  const key = `${email.trim().toLowerCase()}\u0000${clientId}`;
  const hit = recentSends.get(key);
  if (hit && now - hit.at < SEND_DEDUP_TTL_MS) return { ...(await hit.p) };
  const p = insertAndBroadcast(email, body, clientId, images);
  recentSends.set(key, { at: now, p });
  try {
    return await p;
  } catch (e) {
    recentSends.delete(key); // nothing was stored: a retry must insert
    throw e;
  }
}

async function insertAndBroadcast(
  email: string,
  body: string,
  clientId: string | null,
  images: string[] = []
): Promise<ChatMessage> {
  const res = await pool.query(
    `WITH nm AS MATERIALIZED (
       SELECT COALESCE(
                up.display_name,
                (SELECT p.author_name FROM posts p
                 WHERE p.author_email = $1
                 ORDER BY p.created_at DESC LIMIT 1)
              ) AS raw
       FROM (SELECT 1) x
       LEFT JOIN user_profiles up ON up.email = $1
     ), cleaned AS (
       -- cleanDisplayName in SQL. JS trim() also strips U+3000, so btrim does too.
       SELECT btrim(raw, E' \\t\\r\\n\\u3000') AS s FROM nm
     ), ins AS (
       INSERT INTO chat_messages (author_email, author_name, body, images)
       SELECT $1,
              CASE WHEN strpos(s, '@') > 1
                   THEN NULLIF(btrim(substr(s, 1, strpos(s, '@') - 1), E' \\t\\r\\n\\u3000'), '')
                   ELSE NULLIF(s, '')
              END,
              $2,
              $3::text[]
       FROM cleaned
       RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind
     )
     SELECT ins.*, u.user_id
     FROM ins LEFT JOIN users u ON u.email = lower(trim(ins.author_email))`,
    [email, body, images]
  );
  const row = res.rows[0];
  const message = await mapRow(row, email, row.user_id ?? null);
  if (clientId) message.clientId = clientId;

  const { isAuthor: _perReceiver, ...broadcast } = message;
  emitLive({ type: "chat", message: broadcast, action: "create" });
  void markChatRead(email, message.id).catch((e) =>
    console.error("chat markRead after send:", (e as Error)?.message)
  );
  // APNs for @mentioned members on iPhone/iPad (no-op until APNs is configured).
  void pushChatMessage(message, email).catch((e) => console.error("chat push:", (e as Error)?.message));
  return message;
}

/** Edit a chat message's body (author self-fix for typos). Only the original
 *  author may edit, and only while the message is still within its TTL window.
 *  Returns the updated message, or null when the message is not editable
 *  (not found / not the author / already expired). */
export async function editChatMessage(
  id: number,
  email: string,
  body: string,
  viewerEmail: string | null = email
): Promise<ChatMessage | null> {
  const res = await pool.query(
    `UPDATE chat_messages
     SET body = $1, edited = true, edited_at = now()
     WHERE id = $2 AND author_email = $3
       AND created_at >= now() - ($4::text)::interval
       -- A question the on-device Beagle answered stays as it was asked (the answer would read wrong).
       AND NOT EXISTS (SELECT 1 FROM chat_messages a WHERE a.reply_to_id = chat_messages.id AND a.kind = 'beagle_ai')
     RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind`,
    [body, id, email, CHAT_TTL]
  );
  if (res.rowCount === 0) return null;
  return mapRow(res.rows[0], viewerEmail, await emailToUserId(email));
}

/** Edit + broadcast, shared by PATCH /api/chat/[id] and the agent API.
 *  Returns null when the message is not editable. */
export async function editChatMessageAndBroadcast(
  id: number,
  email: string,
  body: string
): Promise<ChatMessage | null> {
  const updated = await editChatMessage(id, email, body, email);
  if (!updated) return null;
  const { isAuthor: _perReceiver, ...broadcast } = updated;
  emitLive({ type: "chat", action: "edit", message: broadcast });
  return updated;
}

/** One message (within the TTL), as seen by `viewerEmail`. */
export async function getChatMessage(id: number, viewerEmail: string | null): Promise<ChatMessage | null> {
  const res = await pool.query(
    `SELECT id, author_email, author_name, body, edited, edited_at, created_at, images, kind, reply_to_id FROM chat_messages
     WHERE id = $1 AND created_at >= now() - ($2::text)::interval`,
    [id, CHAT_TTL]
  );
  const row = res.rows[0];
  if (!row) return null;
  const m = await mapRow(row, viewerEmail, await emailToUserId(row.author_email));
  const names = await resolveDisplayNames([row.author_email]);
  const name = names.get(row.author_email);
  if (name && row.kind !== "beagle_ai") m.authorName = name;
  return m;
}

/** Delete a chat message (admin moderation), and its photos with it. */
export async function deleteChatMessage(id: number): Promise<void> {
  const r = await pool.query(`DELETE FROM chat_messages WHERE id = $1 RETURNING images`, [id]);
  await removeChatFiles((r.rows[0]?.images as string[] | undefined) ?? []);
}

const uploadsDir = () => path.join(process.cwd(), "public", "uploads");

async function removeChatFiles(urls: string[]): Promise<void> {
  await Promise.all(
    urls
      .filter((u) => CHAT_IMAGE_RE.test(u))
      .map((u) => rm(path.join(uploadsDir(), u.slice("/api/media/".length)), { force: true }).catch(() => {}))
  );
}

/** Chat photos live as long as chat messages: every chat-* file older than the
 *  TTL (plus an hour of slack) goes — attached ones with their message, and ones
 *  uploaded but never sent. No bookkeeping needed. Returns how many were removed. */
export async function purgeExpiredChatFiles(now = Date.now()): Promise<number> {
  const dir = uploadsDir();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return 0;
  }
  const cutoff = now - CHAT_FILE_TTL_MS;
  let removed = 0;
  for (const name of names) {
    if (!name.startsWith("chat-")) continue;
    try {
      const st = await stat(path.join(dir, name));
      if (st.mtimeMs < cutoff) {
        await rm(path.join(dir, name), { force: true });
        removed++;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}

/** 24 h (CHAT_TTL) + 1 h. */
export const CHAT_FILE_TTL_MS = 25 * 60 * 60 * 1000;

/** Latest chat message id (global max). 0 when empty. */
export async function getLatestChatId(): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE(max(id), 0)::int AS id FROM chat_messages`
  );
  return res.rows[0].id;
}

/** A user's read cursor (0 when they never read): the apps open the chat at the
 *  first message after it (drikin 2026-10-19). */
export async function getChatLastReadId(email: string): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE((SELECT last_read_id FROM chat_read_state WHERE email = $1), 0)::int AS last_read`,
    [email]
  );
  return res.rows[0].last_read;
}

/** Unread count for a user = messages with id strictly greater than their
 *  read cursor. Never returns negative. */
export async function getUnreadCount(email: string): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE((SELECT last_read_id FROM chat_read_state WHERE email = $1), 0)::int AS last_read`,
    [email]
  );
  const lastRead = res.rows[0].last_read;
  const cnt = await pool.query(
    `SELECT count(*)::int AS c FROM chat_messages
     WHERE id > $1 AND created_at >= now() - ($2::text)::interval
       AND kind IS DISTINCT FROM 'notice' AND kind IS DISTINCT FROM 'shogi' AND kind IS DISTINCT FROM 'beagle_ai'`,
    [lastRead, CHAT_TTL]
  );
  return cnt.rows[0].c;
}

/** Advance a user's read cursor to at least `lastReadId` (monotonic). */
export async function markChatRead(
  email: string,
  lastReadId: number
): Promise<void> {
  await pool.query(
    `INSERT INTO chat_read_state (email, last_read_id, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (email) DO UPDATE SET
       last_read_id = GREATEST(chat_read_state.last_read_id, EXCLUDED.last_read_id),
       updated_at = now()`,
    [email, lastReadId]
  );
}
