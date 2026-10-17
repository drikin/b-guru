/* Voice room actions shared by the native apps (/api/agent/voice/*, agent token
 * with the "voice" scope) and the web (/api/voice/*, session cookie). Each
 * returns { status, body } and the route only does its own authentication. */
import { isAdmin } from "./admin";
import { resolveDisplayName } from "./display-name";
import { findMemberByEmail, isPaidMember } from "./ghost";
import { livekitConfig } from "./livekit";
import { userIdToEmail } from "./user";
import {
  VOICE_ROOM,
  VOICE_TOKEN_TTL_SEC,
  banFromVoice,
  canModerate,
  ensureRoom,
  isVoiceBanned,
  issueJoinToken,
  refreshVoiceState,
  removeParticipant,
  voiceEnabledFor,
} from "./voice";

export interface ActionResult {
  status: number;
  body: Record<string, unknown>;
}

const notAvailable: ActionResult = { status: 404, body: { error: "ボイスルームは使えません", code: "not_found" } };

/** Join token for this member: checks membership with Ghost every time (does
 *  not wait for any periodic re-check) and the voice ban list. */
export async function issueVoiceJoin(email: string, userId: string): Promise<ActionResult> {
  const cfg = livekitConfig();
  if (!cfg || !voiceEnabledFor(email)) return notAvailable;
  let member;
  try {
    member = await findMemberByEmail(email);
  } catch {
    // Ghost に届かないときは入れない（fail closed）。
    return { status: 503, body: { error: "会員確認ができません", code: "server_error", hint: "少し待ってから再試行してください" } };
  }
  if (!member || !isPaidMember(member)) {
    return {
      status: 403,
      body: { error: "BSM 会員資格が確認できません", code: "membership_ended", hint: "backspace.fm で会員状況をご確認ください" },
    };
  }
  if (await isVoiceBanned(email)) {
    return { status: 403, body: { error: "ボイスルームに入れません", code: "forbidden" } };
  }
  await ensureRoom(cfg);
  const name = await resolveDisplayName(email);
  return {
    status: 200,
    body: {
      url: cfg.url,
      token: issueJoinToken(cfg, userId, name),
      room: VOICE_ROOM,
      identity: userId,
      expires_in: VOICE_TOKEN_TTL_SEC,
    },
  };
}

/** Remove someone from the room (admins, or the session's opener while still in
 *  the room). `ban` keeps them out afterwards and is admin-only. */
export async function kickFromVoice(
  email: string,
  userId: string | null,
  input: { user_id?: unknown; ban?: unknown; reason?: unknown }
): Promise<ActionResult> {
  const cfg = livekitConfig();
  if (!cfg || !voiceEnabledFor(email)) return notAvailable;
  const target = typeof input.user_id === "string" ? input.user_id.trim() : "";
  if (!target || target.length > 64) {
    return { status: 400, body: { error: "user_id を指定してください", code: "invalid_request" } };
  }
  if (target === userId) {
    return { status: 400, body: { error: "自分は退出させられません", code: "invalid_request" } };
  }
  if (!(await canModerate(email, userId))) {
    return { status: 403, body: { error: "この操作はできません", code: "forbidden" } };
  }
  const ban = input.ban === true;
  if (ban && !isAdmin(email)) {
    return { status: 403, body: { error: "入室禁止は管理者だけができます", code: "forbidden" } };
  }
  const targetEmail = await userIdToEmail(target);
  if (targetEmail && isAdmin(targetEmail) && !isAdmin(email)) {
    return { status: 403, body: { error: "この操作はできません", code: "forbidden" } };
  }
  if (ban) {
    if (!targetEmail) return { status: 404, body: { error: "会員が見つかりません", code: "not_found" } };
    const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : null;
    await banFromVoice(targetEmail, email, reason);
  }
  await removeParticipant(cfg, target);
  await refreshVoiceState().catch(() => {});
  return { status: 200, body: { ok: true, banned: ban } };
}

// Web routes have no per-token rate bucket like /api/agent/*; a small per-member
// window keeps a stuck client (or a script with a session) from hammering Ghost.
const recent = new Map<string, number[]>();
export function webVoiceRateOk(email: string, limit = 30, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const hits = (recent.get(email) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    recent.set(email, hits);
    return false;
  }
  hits.push(now);
  recent.set(email, hits);
  if (recent.size > 2000) recent.delete(recent.keys().next().value as string);
  return true;
}
