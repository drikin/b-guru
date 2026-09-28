/* Notifications library: reply/like notifications with read/unread state. */
import { pool } from "./db";
import { resolveDisplayNames, cleanDisplayName } from "./display-name";
import { emailToUserId, emailToUserIds } from "./user";

/**
 * A notification as serialized to the client.
 *
 * The recipient's own email is never included (the client already knows who it
 * is), and the actor is identified by the opaque `actorId` — a notification
 * list is served to one member but the actor's address must not travel with it.
 * `isActor` is computed per-recipient so the UI can label "あなた" without
 * needing the actor's email.
 */
export interface Notification {
  id: number;
  type: string; // 'reply' | 'like'
  actorId: string | null;
  actorName: string | null;
  isActor: boolean;
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
 *
 * NOTE: the INPUT keeps `userEmail` / `actorEmail` — the DB stores emails and
 * the callers (beagle/act.ts, api/publish) speak in emails. Only the RETURNED
 * shape is email-free; it is what reaches the client.
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
      type: input.type,
      actorId: await emailToUserId(input.actorEmail),
      actorName: cleanDisplayName(input.actorName) ?? null,
      isActor: input.actorEmail === input.userEmail,
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
    type: r.type,
    actorId: await emailToUserId(r.actor_email),
    actorName: cleanDisplayName(r.actor_name) ?? null,
    isActor: r.actor_email === input.userEmail,
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
  const rows = res.rows;
  const names = await resolveDisplayNames(rows.map((r) => r.actor_email));
  const actorIds = await emailToUserIds(rows.map((r) => r.actor_email));
  return rows.map((r) => {
    const resolved = names.get(r.actor_email) ?? null;
    return {
      id: r.id,
      type: r.type,
      actorId: actorIds.get(r.actor_email?.trim().toLowerCase()) ?? null,
      // Resolved display name wins; fall back to the name stored at write time,
      // reduced to its local part if it is itself an address.
      actorName: resolved ?? cleanDisplayName(r.actor_name) ?? null,
      isActor: r.actor_email === userEmail,
      postId: r.post_id,
      replyId: r.reply_id,
      text: r.text,
      readAt: r.read_at ? new Date(r.read_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
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