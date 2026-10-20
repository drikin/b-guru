/* Who gets an APNs push, and what it says.
 *
 * - Chat: members whose name is @mentioned (same matching as the web bark and
 *   the native stream — chat-mention.ts). Never the author.
 * - Personal: a reply to one of your posts (createNotification type "reply").
 * - Timeline: a new post (not a comment, not a whisper) to devices that chose it.
 *
 * Privacy: the payload carries ids and a generic text only, never the message.
 * The app's Notification Service Extension fetches the real text with the
 * device's own token (mutable-content); if that fails the generic text shows.
 * Everything here is fire-and-forget and a no-op until APNs is configured. */
import { apnsEnabled, isDeadToken, sendApns } from "./apns";
import { fcmEnabled, isDeadFcmToken, sendFcm, toFcmData } from "./fcm";
import { activePushDevices, markPushSent, pushDeviceOwners, removePushDevice, type PushDevice } from "./push-devices";
import { isMentionedIn, mentionNamesFor } from "./chat-mention";
import { resolveDisplayNames } from "./display-name";

export type PushKind = "chat_mention" | "chat_new" | "reply" | "timeline_new";

/** 0:00–7:00 JST — new-message pushes wait (mentions still go out). */
export function isQuietHourJst(now = new Date()): boolean {
  const h = (now.getUTCHours() + 9) % 24;
  return h < 7;
}

/** The APNs payload (pure — tested). */
export function buildPushPayload(kind: PushKind, ids: { messageId?: number; postId?: number | null; replyId?: number | null }) {
  const alert =
    kind === "chat_mention"
      ? { title: "B-guru チャット", body: "あなたへのメンションがあります" }
      : kind === "chat_new"
        ? { title: "B-guru チャット", body: "新着メッセージがあります" }
        : kind === "timeline_new"
          ? { title: "B-guru タイムライン", body: "新しい投稿があります" }
          : { title: "B-guru", body: "あなたの投稿に返信がありました" };
  return {
    aps: {
      alert,
      sound: kind === "chat_mention" ? "bark.caf" : "default",
      "mutable-content": 1,
      category: kind === "chat_mention" ? "mention" : kind === "chat_new" ? "newmsg" : kind === "timeline_new" ? "newpost" : "reply",
      "thread-id": kind === "reply" ? `post-${ids.postId ?? 0}` : kind === "timeline_new" ? "timeline" : "chat",
    },
    kind,
    ...(ids.messageId != null ? { message_id: ids.messageId } : {}),
    ...(ids.postId != null ? { post_id: ids.postId } : {}),
    ...(ids.replyId != null ? { reply_id: ids.replyId } : {}),
  };
}

/** At most this many APNs requests in flight per delivery. */
const SEND_CONCURRENCY = 20;

/** Per recipient + kind: one push per THROTTLE_MS (a burst of mentions becomes one). */
const THROTTLE_MS = 20_000;
const lastPushed = new Map<string, number>();
export function throttled(email: string, kind: PushKind, now = Date.now()): boolean {
  const key = `${kind}:${email}`;
  const prev = lastPushed.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return true;
  lastPushed.set(key, now);
  if (lastPushed.size > 5000) {
    for (const [k, t] of lastPushed) if (now - t > THROTTLE_MS) lastPushed.delete(k);
  }
  return false;
}
export function __resetThrottleForTests() {
  lastPushed.clear();
}

export function pushEnabled(): boolean {
  return apnsEnabled() || fcmEnabled();
}

async function deliver(devices: PushDevice[], payload: Record<string, unknown>, collapseId: string): Promise<number> {
  const sent: string[] = [];
  const data = toFcmData(payload);
  for (let i = 0; i < devices.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      devices.slice(i, i + SEND_CONCURRENCY).map(async (d) => {
        if (d.environment === "fcm") {
          const r = await sendFcm(d.apnsToken, data, { collapseKey: collapseId });
          if (r.status === 200) sent.push(d.apnsToken);
          else if (isDeadFcmToken(r)) await removePushDevice(d.apnsToken).catch(() => {});
          else if (r.reason !== "disabled") console.error("[fcm]", r.status, r.reason);
          return;
        }
        const r = await sendApns(d.apnsToken, d.environment, payload, { collapseId });
        if (r.status === 200) sent.push(d.apnsToken);
        else if (isDeadToken(r)) await removePushDevice(d.apnsToken).catch(() => {});
        else if (r.reason !== "disabled") console.error("[apns]", r.status, r.reason);
      })
    );
  }
  await markPushSent(sent).catch(() => {});
  return sent.length;
}

/** Of the given device owners, those mentioned in `body` (never the author). */
export async function mentionedRecipients(body: string, authorEmail: string, ownerEmails: string[]): Promise<string[]> {
  const author = authorEmail.trim().toLowerCase();
  const owners = [...new Set(ownerEmails)].filter((e) => e !== author);
  if (owners.length === 0 || !body.includes("@")) return [];
  const names = await resolveDisplayNames(owners);
  return owners.filter((e) => isMentionedIn(body, mentionNamesFor([names.get(e) ?? null], e)));
}

export async function pushChatMessage(m: { id: number; body: string }, authorEmail: string): Promise<number> {
  if (!pushEnabled()) return 0;
  const author = authorEmail.trim().toLowerCase();
  const owners = await pushDeviceOwners();
  if (owners.length === 0) return 0;

  // 1) @mentions: their own notification (bark), always — also in quiet hours.
  const mentioned = new Set(await mentionedRecipients(m.body, author, owners));
  let sent = 0;
  const mentionTo = [...mentioned].filter((e) => !throttled(e, "chat_mention"));
  if (mentionTo.length) {
    sent += await deliver(await activePushDevices(mentionTo), buildPushPayload("chat_mention", { messageId: m.id }), `chat-${m.id}`);
  }

  // 2) Everyone else on "all": one rolling "new messages" notification
  //    (same collapse id → replaces the previous one), at most one per 20 s
  //    per member, held during quiet hours. Low traffic, so this stays calm.
  const others = owners.filter((e) => e !== author && !mentioned.has(e));
  if (others.length === 0) return sent;
  const quiet = isQuietHourJst();
  const devices = (await activePushDevices(others)).filter((d) => d.notifyMode === "all" && !(quiet && d.quietHours));
  const recipients = [...new Set(devices.map((d) => d.email))].filter((e) => !throttled(e, "chat_new"));
  if (recipients.length === 0) return sent;
  const allowed = new Set(recipients);
  sent += await deliver(
    devices.filter((d) => allowed.has(d.email)),
    buildPushPayload("chat_new", { messageId: m.id }),
    "chat-new"
  );
  return sent;
}

export async function pushPersonalNotification(
  recipientEmail: string,
  n: { type: string; isActor: boolean; postId: number | null; replyId: number | null }
): Promise<number> {
  if (!pushEnabled() || n.type !== "reply" || n.isActor) return 0;
  if (throttled(recipientEmail.trim().toLowerCase(), "reply")) return 0;
  const devices = await activePushDevices([recipientEmail]);
  if (devices.length === 0) return 0;
  return deliver(devices, buildPushPayload("reply", { postId: n.postId, replyId: n.replyId }), `reply-${n.replyId ?? n.postId}`);
}

/** A new timeline post: to every device that chose timeline notifications, except the
 *  author's. Quiet hours hold it like a chat message; at most one per 20 s per member. */
export async function pushNewPost(postId: number, authorEmail: string): Promise<number> {
  if (!pushEnabled()) return 0;
  const author = authorEmail.trim().toLowerCase();
  const quiet = isQuietHourJst();
  const devices = (await activePushDevices(null)).filter(
    (d) => d.notifyTimeline && d.email !== author && !(quiet && d.quietHours)
  );
  const recipients = [...new Set(devices.map((d) => d.email))].filter((e) => !throttled(e, "timeline_new"));
  if (recipients.length === 0) return 0;
  const allowed = new Set(recipients);
  return deliver(
    devices.filter((d) => allowed.has(d.email)),
    buildPushPayload("timeline_new", { postId }),
    `post-${postId}`
  );
}
