/* Who gets an APNs push, and what it says.
 *
 * - Chat: members whose name is @mentioned (same matching as the web bark and
 *   the native stream — chat-mention.ts). Never the author.
 * - Personal: a reply to one of your posts (createNotification type "reply").
 *
 * Privacy: the payload carries ids and a generic text only, never the message.
 * The app's Notification Service Extension fetches the real text with the
 * device's own token (mutable-content); if that fails the generic text shows.
 * Everything here is fire-and-forget and a no-op until APNs is configured. */
import { apnsEnabled, isDeadToken, sendApns } from "./apns";
import { activePushDevices, markPushSent, pushDeviceOwners, removePushDevice, type PushDevice } from "./push-devices";
import { isMentionedIn, mentionNamesFor } from "./chat-mention";
import { resolveDisplayNames } from "./display-name";

export type PushKind = "chat_mention" | "reply";

/** The APNs payload (pure — tested). */
export function buildPushPayload(kind: PushKind, ids: { messageId?: number; postId?: number | null; replyId?: number | null }) {
  const isChat = kind === "chat_mention";
  return {
    aps: {
      alert: isChat
        ? { title: "B-guru チャット", body: "あなたへのメンションがあります" }
        : { title: "B-guru", body: "あなたの投稿に返信がありました" },
      sound: isChat ? "bark.caf" : "default",
      "mutable-content": 1,
      category: isChat ? "mention" : "reply",
      "thread-id": isChat ? "chat" : `post-${ids.postId ?? 0}`,
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

async function deliver(devices: PushDevice[], payload: object, collapseId: string): Promise<number> {
  const sent: string[] = [];
  for (let i = 0; i < devices.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      devices.slice(i, i + SEND_CONCURRENCY).map(async (d) => {
        const r = await sendApns(d.apnsToken, d.environment, payload, { collapseId });
        if (r.status === 200) sent.push(d.apnsToken);
        else if (isDeadToken(r)) await removePushDevice(d.apnsToken).catch(() => {});
        else console.error("[apns]", r.status, r.reason);
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
  if (!apnsEnabled() || !m.body.includes("@")) return 0;
  // Owners first (one small DISTINCT query), devices only for those mentioned.
  const who = (await mentionedRecipients(m.body, authorEmail, await pushDeviceOwners())).filter(
    (e) => !throttled(e, "chat_mention")
  );
  if (who.length === 0) return 0;
  return deliver(await activePushDevices(who), buildPushPayload("chat_mention", { messageId: m.id }), `chat-${m.id}`);
}

export async function pushPersonalNotification(
  recipientEmail: string,
  n: { type: string; isActor: boolean; postId: number | null; replyId: number | null }
): Promise<number> {
  if (!apnsEnabled() || n.type !== "reply" || n.isActor) return 0;
  if (throttled(recipientEmail.trim().toLowerCase(), "reply")) return 0;
  const devices = await activePushDevices([recipientEmail]);
  if (devices.length === 0) return 0;
  return deliver(devices, buildPushPayload("reply", { postId: n.postId, replyId: n.replyId }), `reply-${n.replyId ?? n.postId}`);
}
