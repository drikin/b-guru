/* Realtime community chat — a single global room for lightweight,
 * back-and-forth between online members. Persisted so history can be
 * re-loaded when the bubble panel is opened, with a per-user read cursor
 * driving the unread badge on the bubble.
 *
 * This is the "ephemeral chat" counterpart to the timeline: chat messages
 * live in `chat_messages` and never appear in the feed.
 */
import { pool } from "./db";
import { gravatarUrl } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emitLive } from "./live";

export interface ChatMessage {
  id: number;
  authorEmail: string;
  authorName: string | null;
  body: string;
  createdAt: string; // ISO timestamp
  avatar: string | null;
  edited: boolean; // author corrected a typo after posting
  editedAt: string | null; // ISO timestamp of the edit
}

/** Max body length for a chat message. */
export const CHAT_MAX_BODY = 1000;
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
    } catch (e) {
      console.error("chat sweeper error:", (e as any)?.message);
    }
  }, 60_000);
}

/** Map a chat_messages row into the API shape. */
function mapRow(r: {
  id: number;
  author_email: string;
  author_name: string | null;
  body: string;
  edited: boolean;
  edited_at: Date | string | null;
  created_at: Date | string;
}): ChatMessage {
  return {
    id: r.id,
    authorEmail: r.author_email,
    authorName: r.author_name,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    avatar: gravatarUrl(r.author_email),
    edited: r.edited,
    editedAt: r.edited_at ? new Date(r.edited_at).toISOString() : null,
  };
}

/** Recent chat history, oldest→newest for natural reading order. */
export async function listChatMessages(opts: {
  before?: number;
  limit?: number;
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
  return rows.map((r) => {
    const m = mapRow(r);
    const resolved = names.get(r.author_email) ?? null;
    if (resolved) m.authorName = resolved;
    return m;
  });
}

/** Insert a new chat message. Returns the created message. */
export async function createChatMessage(
  email: string,
  name: string | null,
  body: string
): Promise<ChatMessage> {
  const res = await pool.query(
    `INSERT INTO chat_messages (author_email, author_name, body)
     VALUES ($1, $2, $3)
     RETURNING id, author_email, author_name, body, edited, edited_at, created_at`,
    [email, name, body]
  );
  return mapRow(res.rows[0]);
}

/** Edit a chat message's body (author self-fix for typos). Only the original
 *  author may edit, and only while the message is still within its TTL window.
 *  Returns the updated message, or null when the message is not editable
 *  (not found / not the author / already expired). */
export async function editChatMessage(
  id: number,
  email: string,
  body: string
): Promise<ChatMessage | null> {
  const res = await pool.query(
    `UPDATE chat_messages
     SET body = $1, edited = true, edited_at = now()
     WHERE id = $2 AND author_email = $3
       AND created_at >= now() - ($4::text)::interval
     RETURNING id, author_email, author_name, body, edited, edited_at, created_at`,
    [body, id, email, CHAT_TTL]
  );
  if (res.rowCount === 0) return null;
  return mapRow(res.rows[0]);
}

/** Delete a chat message (admin moderation). */
export async function deleteChatMessage(id: number): Promise<void> {
  await pool.query(`DELETE FROM chat_messages WHERE id = $1`, [id]);
}

/** Latest chat message id (global max). 0 when empty. */
export async function getLatestChatId(): Promise<number> {
  const res = await pool.query(
    `SELECT COALESCE(max(id), 0)::int AS id FROM chat_messages`
  );
  return res.rows[0].id;
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
     WHERE id > $1 AND created_at >= now() - ($2::text)::interval`,
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
