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

export interface ChatMessage {
  id: number;
  authorEmail: string;
  authorName: string | null;
  body: string;
  createdAt: string; // ISO timestamp
  avatar: string | null;
}

/** Max body length for a chat message. */
export const CHAT_MAX_BODY = 1000;
/** Default page size returned by GET /api/chat. */
export const CHAT_PAGE_SIZE = 50;

/** Map a chat_messages row into the API shape. */
function mapRow(r: {
  id: number;
  author_email: string;
  author_name: string | null;
  body: string;
  created_at: Date | string;
}): ChatMessage {
  return {
    id: r.id,
    authorEmail: r.author_email,
    authorName: r.author_name,
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
    avatar: gravatarUrl(r.author_email),
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
     ORDER BY id DESC
     LIMIT $2`,
    [opts.before ?? null, limit]
  );
  // Reverse so the returned array is chronological (oldest first).
  return res.rows.reverse().map(mapRow);
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
     RETURNING id, author_email, author_name, body, created_at`,
    [email, name, body]
  );
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
    `SELECT count(*)::int AS c FROM chat_messages WHERE id > $1`,
    [lastRead]
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
