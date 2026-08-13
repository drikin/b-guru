/* Notifications library: reply/like notifications with read/unread state. */
import { pool } from "./db";

export interface Notification {
  id: number;
  userEmail: string;
  type: string; // 'reply' | 'like'
  actorEmail: string;
  actorName: string | null;
  postId: number | null;
  replyId: number | null;
  text: string;
  readAt: string | null;
  createdAt: string;
}

/**
 * Create a notification. Caller should ensure the notification is meaningful
 * (e.g. a reply to someone else's post). Idempotent-ish: dedupes consecutive
 * identical (user, type, replyId) entries so spamming replies/ likes doesn't
 * flood the same user.
 */
export async function createNotification(input: {
  userEmail: string;
  type: string;
  actorEmail: string;
  actorName?: string | null;
  postId?: number | null;
  replyId?: number | null;
  text: string;
}): Promise<Notification> {
  // De-duplicate: if an identical unread notification already exists, skip.
  const dup = await pool.query(
    `SELECT id FROM notifications
     WHERE user_email = $1 AND type = $2 AND actor_email = $3
       AND (reply_id IS NOT DISTINCT FROM $4)
       AND read_at IS NULL
     LIMIT 1`,
    [input.userEmail, input.type, input.actorEmail, input.replyId ?? null]
  );
  if (dup.rows.length > 0) {
    const r = dup.rows[0];
    return {
      id: r.id,
      userEmail: input.userEmail,
      type: input.type,
      actorEmail: input.actorEmail,
      actorName: input.actorName ?? null,
      postId: input.postId ?? null,
      replyId: input.replyId ?? null,
      text: input.text,
      readAt: null,
      createdAt: "",
    };
  }

  const res = await pool.query(
    `INSERT INTO notifications (user_email, type, actor_email, actor_name, post_id, reply_id, text)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      input.userEmail,
      input.type,
      input.actorEmail,
      input.actorName ?? null,
      input.postId ?? null,
      input.replyId ?? null,
      input.text,
    ]
  );
  const r = res.rows[0];
  return {
    id: r.id,
    userEmail: r.user_email,
    type: r.type,
    actorEmail: r.actor_email,
    actorName: r.actor_name,
    postId: r.post_id,
    replyId: r.reply_id,
    text: r.text,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

/** List notifications for a user, newest first. */
export async function listNotifications(userEmail: string): Promise<Notification[]> {
  const res = await pool.query(
    `SELECT * FROM notifications WHERE user_email = $1 ORDER BY id DESC LIMIT 50`,
    [userEmail]
  );
  return res.rows.map((r) => ({
    id: r.id,
    userEmail: r.user_email,
    type: r.type,
    actorEmail: r.actor_email,
    actorName: r.actor_name,
    postId: r.post_id,
    replyId: r.reply_id,
    text: r.text,
    readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Count unread notifications for a user. */
export async function countUnreadNotifications(userEmail: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*) AS c FROM notifications WHERE user_email = $1 AND read_at IS NULL`,
    [userEmail]
  );
  return Number(res.rows[0].c);
}

/** Mark a single notification as read. */
export async function markNotificationRead(id: number, userEmail: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE id = $1 AND user_email = $2 AND read_at IS NULL`,
    [id, userEmail]
  );
  return (res.rowCount ?? 0) > 0;
}

/** Mark all notifications as read for a user. */
export async function markAllNotificationsRead(userEmail: string): Promise<number> {
  const res = await pool.query(
    `UPDATE notifications SET read_at = now()
     WHERE user_email = $1 AND read_at IS NULL`,
    [userEmail]
  );
  return res.rowCount ?? 0;
}

/** Delete all notifications for a user. */
export async function clearAllNotifications(userEmail: string): Promise<number> {
  const res = await pool.query(
    `DELETE FROM notifications WHERE user_email = $1`,
    [userEmail]
  );
  return res.rowCount ?? 0;
}
