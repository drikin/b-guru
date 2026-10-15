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
import { activePushDevices, markPushSent, removePushDevice, type PushDevice } from "./push-devices";
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

async function deliver(devices: PushDevice[], payload: object, collapseId: string): Promise<number> {
  const sent: string[] = [];
  await Promise.all(
    devices.map(async (d) => {
      const r = await sendApns(d.apnsToken, d.environment, payload, { collapseId });
      if (r.status === 200) sent.push(d.apnsToken);
      else if (isDeadToken(r)) await removePushDevice(d.apnsToken).catch(() => {});
      else console.error("[apns]", r.status, r.reason);
    })
  );
  await markPushSent(sent).catch(() => {});
  return sent.length;
}

/** Owners of push devices mentioned in `body`, excluding the author. */
export async function mentionedRecipients(body: string, authorEmail: string, devices: PushDevice[]): Promise<string[]> {
  const author = authorEmail.trim().toLowerCase();
  const owners = [...new Set(devices.map((d) => d.email))].filter((e) => e !== author);
  if (owners.length === 0 || !body.includes("@")) return [];
  const names = await resolveDisplayNames(owners);
  return owners.filter((e) => isMentionedIn(body, mentionNamesFor([names.get(e) ?? null], e)));
}

export async function pushChatMessage(m: { id: number; body: string }, authorEmail: string): Promise<number> {
  if (!apnsEnabled() || !m.body.includes("@")) return 0;
  const devices = await activePushDevices(null);
  const who = new Set(await mentionedRecipients(m.body, authorEmail, devices));
  if (who.size === 0) return 0;
  return deliver(
    devices.filter((d) => who.has(d.email)),
    buildPushPayload("chat_mention", { messageId: m.id }),
    `chat-${m.id}`
  );
}

export async function pushPersonalNotification(
  recipientEmail: string,
  n: { type: string; isActor: boolean; postId: number | null; replyId: number | null }
): Promise<number> {
  if (!apnsEnabled() || n.type !== "reply" || n.isActor) return 0;
  const devices = await activePushDevices([recipientEmail]);
  if (devices.length === 0) return 0;
  return deliver(devices, buildPushPayload("reply", { postId: n.postId, replyId: n.replyId }), `reply-${n.replyId ?? n.postId}`);
}
