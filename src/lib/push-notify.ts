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
import { emitPersonal, type SyncScope } from "./personal-live";

export type PushKind =
  | "chat_mention" | "chat_new" | "reply" | "timeline_new" | "shogi_offer" | "shogi_turn" | "dm" | "offkai_start"
  | "voice_handoff";

/** 0:00–7:00 JST — new-message pushes wait (mentions still go out). */
export function isQuietHourJst(now = new Date()): boolean {
  const h = (now.getUTCHours() + 9) % 24;
  return h < 7;
}

/** The APNs payload (pure — tested). */
export function buildPushPayload(
  kind: PushKind,
  ids: { messageId?: number; postId?: number | null; replyId?: number | null; gameId?: number }
) {
  if (kind === "shogi_offer" || kind === "shogi_turn") return buildShogiPayload(kind, ids.gameId ?? 0);
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

/** ☗ 将棋: ids only (the app reads the game with its own token), one notification per game. */
export function buildShogiPayload(kind: "shogi_offer" | "shogi_turn", gameId: number) {
  return {
    aps: {
      alert:
        kind === "shogi_offer"
          ? { title: "☗ 将棋", body: "対局の申し込みが届きました" }
          : { title: "☗ 将棋", body: "あなたの番です" },
      sound: "default",
      category: kind === "shogi_offer" ? "shogioffer" : "shogiturn",
      "thread-id": `shogi-${gameId}`,
    },
    kind,
    game_id: gameId,
  };
}

/** 🍻 オフ会が始まった（1 回だけ）。中身は id だけ、文は固定（場所は出さない）。 */
export function buildOffkaiPayload(eventId: number) {
  return {
    aps: {
      alert: { title: "🍻 オフ会", body: "オフ会が始まりました。チャットの 🍻 から聞けます" },
      sound: "default",
      category: "offkai",
      "thread-id": `offkai-${eventId}`,
    },
    kind: "offkai_start",
    event_id: eventId,
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

async function deliver(
  devices: PushDevice[],
  payload: Record<string, unknown>,
  collapseId: string,
  opts: { background?: boolean; ttlSec?: number } = {}
): Promise<number> {
  const sent: string[] = [];
  const data = toFcmData(payload);
  for (let i = 0; i < devices.length; i += SEND_CONCURRENCY) {
    await Promise.all(
      devices.slice(i, i + SEND_CONCURRENCY).map(async (d) => {
        if (d.environment === "fcm") {
          const r = await sendFcm(d.apnsToken, data, {
            collapseKey: collapseId,
            ttlSec: opts.ttlSec,
            priority: opts.background ? "NORMAL" : "HIGH",
          });
          if (r.status === 200) sent.push(d.apnsToken);
          else if (isDeadFcmToken(r)) await removePushDevice(d.apnsToken).catch(() => {});
          else if (r.reason !== "disabled") console.error("[fcm]", r.status, r.reason);
          return;
        }
        const r = await sendApns(d.apnsToken, d.environment, payload, {
          collapseId,
          pushType: opts.background ? "background" : "alert",
          expirationSec: opts.ttlSec,
        });
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

/** `alsoMention`: treated like an @mention (its own notification, also in quiet hours) — 🐶 a member's
 *  「みんなに」 reminder reaches the one who asked it (owner 2026-10-27). */
export async function pushChatMessage(m: { id: number; body: string }, authorEmail: string, alsoMention: string[] = []): Promise<number> {
  if (!pushEnabled()) return 0;
  const author = authorEmail.trim().toLowerCase();
  const owners = await pushDeviceOwners();
  if (owners.length === 0) return 0;

  // 1) @mentions: their own notification (bark), always — also in quiet hours.
  const mentioned = new Set(await mentionedRecipients(m.body, author, owners));
  for (const e of alsoMention.map((x) => x.trim().toLowerCase())) if (owners.includes(e) && e !== author) mentioned.add(e);
  let sent = 0;
  const mentionTo = [...mentioned].filter((e) => !throttled(e, "chat_mention"));
  if (mentionTo.length) {
    sent += await deliver(await activePushDevices(mentionTo), buildPushPayload("chat_mention", { messageId: m.id }), `chat-${m.id}`);
    notePushed(mentionTo, "chat", m.id);
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
  notePushed(recipients, "chat", m.id);
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
  if (n.postId != null) notePushed([recipientEmail], `reply:${n.postId}`, n.replyId ?? n.postId);
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

/** ☗ 将棋の通知（指名された・ゆっくり対局で自分の番）。対応したアプリ（notify_shogi）だけに、
 *  静かな時間（0〜7 時、端末の設定どおり）は送らない。対局ごとに 1 件にまとめる（collapse）。 */
export async function pushShogi(recipientEmail: string, kind: "shogi_offer" | "shogi_turn", gameId: number): Promise<number> {
  if (!pushEnabled()) return 0;
  const quiet = isQuietHourJst();
  const devices = (await activePushDevices([recipientEmail])).filter((d) => d.notifyShogi && !(quiet && d.quietHours));
  if (devices.length === 0) return 0;
  notePushed([recipientEmail], `shogi:${gameId}`, gameId);
  return deliver(devices, buildShogiPayload(kind, gameId), `shogi-${gameId}`);
}

/** ✉️ 簡易 DM: ids と決まった文言だけ（ほかの通知と同じ。本文と送り主の名前は端末が自分の鍵で読む:
 *  iPhone は NSE が GET /api/agent/dm/messages/{id}、Android はアプリが同じものを読む）。
 *  読めなかったときは「B-guru DM／DM が届きました」のまま。会話ごとに 1 件にまとめる（collapse）。 */
export function buildDmPayload(messageId: number, senderUserId: string) {
  return {
    aps: {
      alert: { title: "B-guru DM", body: "DM が届きました" },
      sound: "default",
      "mutable-content": 1,
      category: "dm",
      "thread-id": `dm-${senderUserId}`,
    },
    kind: "dm" as const,
    // dm_id, not message_id: apps from before DMs would look up a CHAT message by message_id
    // (another member's text under the DM's number). They show the generic line instead.
    dm_id: messageId,
    peer_id: senderUserId,
  };
}

/** DM の文言（通知の題と本文。端末が本文を読めたとき・Android と iPhone で同じ）。 */
export function dmNotificationText(senderName: string | null, body: string): { title: string; body: string } {
  const name = (senderName ?? "").trim() || "会員";
  const clipped = body.length > 240 ? body.slice(0, 240) + "…" : body;
  return { title: `${name}さんからの DM`, body: clipped };
}

/** DM が届いた: 相手の端末すべてへ（自分宛ての 1 通なので、静かな時間・回数でまとめない。
 *  同じ人からの続きは collapse で最新の 1 件に置き換わる）。 */
export async function pushDm(recipientEmail: string, messageId: number, senderUserId: string): Promise<number> {
  if (!pushEnabled()) return 0;
  const devices = await activePushDevices([recipientEmail]);
  if (devices.length === 0) return 0;
  notePushed([recipientEmail], `dm:${senderUserId}`, messageId);
  return deliver(devices, buildDmPayload(messageId, senderUserId), `dm-${senderUserId}`);
}

/** 🍻 オフ会が始まった: 始めた人以外の全端末へ 1 回だけ。静かな時間（0〜7 時）を選んだ端末には送らない。 */
export async function pushOffkaiStart(eventId: number, starterEmail: string): Promise<number> {
  if (!pushEnabled()) return 0;
  const starter = starterEmail.trim().toLowerCase();
  const quiet = isQuietHourJst();
  const devices = (await activePushDevices(null)).filter((d) => d.email !== starter && !(quiet && d.quietHours));
  if (devices.length === 0) return 0;
  notePushed(new Set(devices.map((d) => d.email)), `offkai:${eventId}`, eventId);
  return deliver(devices, buildOffkaiPayload(eventId), `offkai-${eventId}`);
}

/* ---- 既読で知らせを消す（read_sync、docs/device-sync-spec.md） ----
 * push を送った相手ごと・範囲ごとに「送った最大 id」を覚えておき、既読がそこまで進んだら
 * その人の notify_sync 端末へ消す合図（background push / FCM data）を 1 回だけ送る。
 * 覚えはメモリだけ（3 日で忘れる。再起動で消えたら合図は出ない＝アプリが前に出たときの掃除に任せる）。 */
const LEDGER_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const ledger = new Map<string, Map<string, { id: number; at: number }>>();

function notePushed(emails: Iterable<string>, key: string, id: number, now = Date.now()): void {
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    let m = ledger.get(email);
    if (!m) ledger.set(email, (m = new Map()));
    for (const [k, v] of m) if (now - v.at >= LEDGER_TTL_MS) m.delete(k); // 読まれないまま古くなった覚え
    const prev = m.get(key);
    m.set(key, { id: Math.max(id, prev ? prev.id : 0), at: now });
  }
  if (ledger.size > 2000) {
    for (const [e, m] of ledger) {
      for (const [k, v] of m) if (now - v.at >= LEDGER_TTL_MS) m.delete(k);
      if (m.size === 0) ledger.delete(e);
    }
  }
}

/** 合図の collapse id: 範囲ごと（相手・投稿・対局ごと）。端末がオフラインの間に別の相手の合図で上書きされないように。 */
function syncCollapseId(s: SyncScope): string {
  const id =
    s.scope === "dm" ? s.peer_id : s.scope === "reply" ? s.post_id : s.scope === "shogi" ? s.game_id : s.scope === "offkai" ? s.event_id : "";
  return `sync-${s.scope}${id === "" ? "" : `-${id}`}`.slice(0, 64);
}

/** この既読で消える覚え（消したものを返す）。純粋に近い（テスト用に export）。 */
export function takeCleared(email: string, s: SyncScope, now = Date.now()): string[] {
  const m = ledger.get(email.trim().toLowerCase());
  if (!m) return [];
  const live = (k: string) => {
    const v = m.get(k);
    return v && now - v.at < LEDGER_TTL_MS ? v : null;
  };
  let keys: string[];
  switch (s.scope) {
    case "chat": {
      const v = live("chat");
      keys = v && s.up_to >= v.id ? ["chat"] : [];
      break;
    }
    case "dm": {
      const v = live(`dm:${s.peer_id}`);
      keys = v && s.up_to >= v.id ? [`dm:${s.peer_id}`] : [];
      break;
    }
    case "reply":
      keys = live(`reply:${s.post_id}`) ? [`reply:${s.post_id}`] : [];
      break;
    case "reply_all":
      keys = [...m.keys()].filter((k) => k.startsWith("reply:") && live(k));
      break;
    case "shogi":
      keys = live(`shogi:${s.game_id}`) ? [`shogi:${s.game_id}`] : [];
      break;
    case "offkai":
      keys = live(`offkai:${s.event_id}`) ? [`offkai:${s.event_id}`] : [];
      break;
  }
  for (const k of keys) m.delete(k);
  if (m.size === 0) ledger.delete(email.trim().toLowerCase());
  return keys;
}

/** 消す合図の本体（APNs は background push、FCM は data）。 */
export function buildSyncPayload(s: SyncScope) {
  return { aps: { "content-available": 1 }, kind: "read_sync" as const, ...s };
}

/** 既読が進んだ: 本人のストリームへ `event: sync`（Mac がアプリ内の知らせを消す）と、
 *  その範囲の push を送っていたら notify_sync 端末へ消す合図。fire-and-forget で呼ぶ。 */
export async function syncRead(email: string, s: SyncScope): Promise<number> {
  const me = email.trim().toLowerCase();
  if (!me) return 0;
  emitPersonal(me, { type: "sync", sync: s });
  if (takeCleared(me, s).length === 0 || !pushEnabled()) return 0;
  const devices = (await activePushDevices([me])).filter((d) => d.notifySync);
  if (devices.length === 0) return 0;
  return deliver(devices, buildSyncPayload(s), syncCollapseId(s), { background: true, ttlSec: 24 * 3600 });
}

/** 🍻 が終わった: 「始まりました」を受け取った全員へ。 */
export async function syncOffkaiEnded(eventId: number): Promise<void> {
  const key = `offkai:${eventId}`;
  const emails = [...ledger.entries()].filter(([, m]) => m.has(key)).map(([e]) => e);
  for (const e of emails) await syncRead(e, { scope: "offkai", event_id: eventId }).catch(() => 0);
}

export function __resetSyncLedgerForTests() {
  ledger.clear();
}
export const __notePushedForTests = notePushed;

/* ---- 音声をスマホで続ける（voice_handoff、docs/device-sync-spec.md） ---- */
export type HandoffTarget = "offkai" | "voice" | "room";

export function buildVoiceHandoffPayload(target: HandoffTarget, mic: boolean, eventId?: number | null) {
  // Android は同じ文を自分で組み立てる（DeviceSync.kt の VoiceHandoff.text）。
  const micText = `（マイク${mic ? "オン" : "オフ"}）`;
  const body =
    target === "offkai"
      ? "🍻 オフ会の音声をこのスマホで続けます。タップして切り替え"
      : target === "room"
        ? `🏠 部室の音声をこのスマホで続けます${micText}。タップして切り替え`
        : `ボイスルームの音声をこのスマホで続けます${micText}。タップして切り替え`;
  return {
    aps: {
      alert: { title: "🎧 音声をこの端末で続ける", body },
      sound: "default",
      category: "voicehandoff",
      "thread-id": "voice-handoff",
    },
    kind: "voice_handoff" as const,
    target,
    mic,
    ...(target === "offkai" && eventId != null ? { event_id: eventId } : {}),
  };
}

/** 本人の操作で本人のスマホへ（静かな時間でも送る）。同じ機能は 20 秒に 1 回まで、5 分で期限切れ。
 *  返り値は送れた端末の数（0 = 続けられるスマホがない）。 */
export async function pushVoiceHandoff(email: string, target: HandoffTarget, mic: boolean, eventId?: number | null): Promise<number> {
  if (!pushEnabled()) return 0;
  const me = email.trim().toLowerCase();
  const devices = (await activePushDevices([me])).filter((d) => d.notifySync);
  if (devices.length === 0) return 0;
  // 同じ機能を少し前に送った（まだ届いている）。機能が違えば送り直す（collapse で置き換わる）。
  const key = `${me}:${target}`;
  const now = Date.now();
  const prev = handoffSentAt.get(key);
  if (prev !== undefined && now - prev < THROTTLE_MS) return devices.length;
  const n = await deliver(devices, buildVoiceHandoffPayload(target, mic, eventId), "voice-handoff", { ttlSec: 300 });
  if (n > 0) handoffSentAt.set(key, now); // 送れなかったときは次の押し直しを止めない
  if (handoffSentAt.size > 2000) for (const [k, t] of handoffSentAt) if (now - t >= THROTTLE_MS) handoffSentAt.delete(k);
  return n;
}
const handoffSentAt = new Map<string, number>();
