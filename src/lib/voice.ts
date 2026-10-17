/* Voice room (ボイスルーム) — one room for the whole community, open while
 * someone is in it. LiveKit (Cloud) carries the audio and signalling; this
 * server only issues join tokens, mirrors who is in the room, and moderates.
 * Nothing about calls lives in this Node process except a cache, so a pm2
 * restart / deploy never drops a call (LiveKit is the source of truth and the
 * cache is rebuilt from ListParticipants).
 *
 * Privacy: LiveKit identities are opaque users.user_id, names are display
 * names; no email ever reaches LiveKit or the SSE broadcast (see live.ts).
 *
 * Rollout: VOICE_ALLOW_EMAILS (comma-separated) limits who may join while we
 * try it out; unset = every paid member. Without LiveKit config it is off. */
import { pool } from "./db";
import { emitLive } from "./live";
import { gravatarUrl } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { isAdmin } from "./admin";
import { livekitConfig, roomService, signAccessToken, type LiveKitConfig } from "./livekit";

/** The single community room (LiveKit room name). */
export const VOICE_ROOM = "bguru-lounge";
/** Join tokens are only needed to connect (LiveKit refreshes them in-session), so
 *  keep them short: a removed / banned member cannot reuse one for long. */
export const VOICE_TOKEN_TTL_SEC = 2 * 60;
/** Room capacity (LiveKit max_participants), listeners included. */
export const VOICE_MAX_PARTICIPANTS = 100;
/** At most this many people with their mic on at once. Enforced by the apps and
 *  the web before unmuting (a closed members' room: a soft limit is enough). */
export const VOICE_MAX_SPEAKERS = 10;
/** LiveKit closes the room this long after the last person leaves. */
export const VOICE_EMPTY_TIMEOUT_SEC = 60;

export interface VoiceParticipant {
  userId: string;
  name: string | null;
  avatar: string | null;
}

export interface VoiceState {
  active: boolean;
  /** user_id of whoever opened the current session (first to join). */
  openedBy: string | null;
  startedAt: string | null;
  participants: VoiceParticipant[];
}

const EMPTY: VoiceState = { active: false, openedBy: null, startedAt: null, participants: [] };

/** Whether this email may use voice at all (config + rollout allowlist). */
export function voiceEnabledFor(email: string | null | undefined): boolean {
  if (!livekitConfig() || !email) return false;
  const raw = process.env.VOICE_ALLOW_EMAILS?.trim();
  if (!raw) return true;
  const allow = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allow.includes(email.trim().toLowerCase());
}

/** Build the join grant: this room only, microphone only, no data channel. */
export function joinGrant(room: string) {
  return {
    room,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: ["microphone"],
    canUpdateOwnMetadata: false,
  };
}

export function issueJoinToken(cfg: LiveKitConfig, userId: string, name: string | null): string {
  return signAccessToken(cfg, {
    identity: userId,
    name: name ?? undefined,
    ttlSec: VOICE_TOKEN_TTL_SEC,
    video: joinGrant(VOICE_ROOM),
    // If a reconnect re-creates the room, keep our limits instead of the shared
    // LiveKit server's defaults (max 10, which suits rec, not this room).
    roomConfig: {
      maxParticipants: VOICE_MAX_PARTICIPANTS,
      emptyTimeout: VOICE_EMPTY_TIMEOUT_SEC,
      departureTimeout: 20,
    },
  });
}

/** Make sure the room exists with our limits (CreateRoom is idempotent). */
export async function ensureRoom(cfg: LiveKitConfig): Promise<void> {
  await roomService(cfg, "CreateRoom", {
    name: VOICE_ROOM,
    empty_timeout: VOICE_EMPTY_TIMEOUT_SEC,
    departure_timeout: 20,
    max_participants: VOICE_MAX_PARTICIPANTS,
  });
}

// ---- bans ----

export async function isVoiceBanned(email: string): Promise<boolean> {
  const r = await pool.query(`SELECT 1 FROM voice_bans WHERE email = $1`, [email.trim().toLowerCase()]);
  return (r.rowCount ?? 0) > 0;
}

async function isUserIdBanned(userId: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM voice_bans b JOIN users u ON u.email = b.email WHERE u.user_id = $1`,
    [userId]
  );
  return (r.rowCount ?? 0) > 0;
}

// ---- state (cache of LiveKit's participant list) ----

type G = {
  __voiceState?: VoiceState;
  __voiceFetchedAt?: number;
  __voiceRefresh?: Promise<VoiceState> | null;
  __voiceQueued?: Promise<VoiceState> | null;
};
const g = globalThis as unknown as G;
const STALE_MS = 15_000;

interface LkParticipant {
  identity?: string;
  name?: string;
  state?: string | number;
}

/** Map LiveKit identities (user_ids) to names/avatars from our DB. Unknown
 *  identities (not a B-guru user) are dropped. */
export async function describeParticipants(identities: string[]): Promise<VoiceParticipant[]> {
  const ids = Array.from(new Set(identities.filter(Boolean)));
  if (ids.length === 0) return [];
  const r = await pool.query(`SELECT user_id, email FROM users WHERE user_id = ANY($1::text[])`, [ids]);
  const emailOf = new Map<string, string>(r.rows.map((row) => [row.user_id as string, row.email as string]));
  const names = await resolveDisplayNames(Array.from(emailOf.values()));
  return ids
    .filter((id) => emailOf.has(id))
    .map((id) => {
      const email = emailOf.get(id)!;
      return { userId: id, name: names.get(email) ?? null, avatar: gravatarUrl(email) };
    });
}

async function currentSession(): Promise<{ openedBy: string | null; startedAt: string | null }> {
  const r = await pool.query(
    `SELECT opened_by, started_at FROM voice_sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1`
  );
  const row = r.rows[0];
  return row
    ? { openedBy: row.opened_by ?? null, startedAt: new Date(row.started_at).toISOString() }
    : { openedBy: null, startedAt: null };
}

const sameState = (a: VoiceState, b: VoiceState) =>
  a.active === b.active &&
  a.openedBy === b.openedBy &&
  a.participants.map((p) => p.userId).join(",") === b.participants.map((p) => p.userId).join(",");

/** Re-read the participant list from LiveKit, update the cache, and broadcast
 *  when it changed. A call made while one is running gets a fresh run after it
 *  (it may follow a DB change the running one has not seen); further calls in
 *  that window share that queued run. */
export async function refreshVoiceState(): Promise<VoiceState> {
  const cfg = livekitConfig();
  if (!cfg) return EMPTY;
  if (g.__voiceRefresh) {
    if (!g.__voiceQueued) {
      g.__voiceQueued = g.__voiceRefresh
        .catch(() => EMPTY)
        .then(() => {
          g.__voiceQueued = null;
          return refreshVoiceState();
        });
    }
    return g.__voiceQueued;
  }
  g.__voiceRefresh = (async () => {
    try {
      const res = await roomService<{ participants?: LkParticipant[] }>(cfg, "ListParticipants", { room: VOICE_ROOM }, VOICE_ROOM);
      // state: JOINING/JOINED/ACTIVE count as present; DISCONNECTED does not.
      const live = (res?.participants ?? []).filter((p) => p.state !== "DISCONNECTED" && p.state !== 3);
      const participants = await describeParticipants(live.map((p) => p.identity ?? ""));
      // Nobody left: close whatever session is open (covers a missed room_finished).
      if (participants.length === 0) await closeOpenSessions(null);
      const session = participants.length > 0 ? await currentSession() : { openedBy: null, startedAt: null };
      const next: VoiceState = { active: participants.length > 0, ...session, participants };
      const prev = g.__voiceState;
      g.__voiceState = next;
      if (next.active) ensureSpeakerGuard();
      g.__voiceFetchedAt = Date.now();
      if (!prev || !sameState(prev, next)) emitLive({ type: "voice", state: next });
      return next;
    } finally {
      g.__voiceRefresh = null;
    }
  })();
  return g.__voiceRefresh;
}

/** Cached state; refreshes from LiveKit when older than 15 s. */
export async function getVoiceState(): Promise<VoiceState> {
  if (!livekitConfig()) return EMPTY;
  if (g.__voiceState && Date.now() - (g.__voiceFetchedAt ?? 0) < STALE_MS) return g.__voiceState;
  try {
    return await refreshVoiceState();
  } catch (e) {
    console.error("[voice] refresh failed:", (e as Error)?.message);
    return g.__voiceState ?? EMPTY;
  }
}

// ---- webhook bookkeeping (sessions / participation log, kept 30 days) ----

export interface LkWebhookEvent {
  id?: string;
  event?: string;
  room?: { name?: string; sid?: string };
  participant?: { identity?: string };
}

/** Close open sessions (all, or all but the given LiveKit room sid). At most one
 *  session is open at a time (unique index), keyed by the LiveKit room sid. */
async function closeOpenSessions(exceptSid: string | null): Promise<void> {
  const r = await pool.query(
    `UPDATE voice_sessions SET ended_at = now()
     WHERE ended_at IS NULL AND ($1::text IS NULL OR livekit_sid IS DISTINCT FROM $1)
     RETURNING id`,
    [exceptSid]
  );
  if ((r.rowCount ?? 0) > 0) {
    await pool.query(
      `UPDATE voice_participations SET left_at = now()
       WHERE left_at IS NULL AND session_id = ANY($1::int[])`,
      [r.rows.map((row) => row.id)]
    );
  }
}

/** Webhook deliveries can be retried or replayed; handle each event id once. */
const seenEvents = new Map<string, number>();
function firstDelivery(id: string | undefined): boolean {
  if (!id) return true;
  if (seenEvents.has(id)) return false;
  seenEvents.set(id, Date.now());
  if (seenEvents.size > 1000) {
    const oldest = seenEvents.keys().next().value;
    if (oldest !== undefined) seenEvents.delete(oldest);
  }
  return true;
}

export async function handleWebhookEvent(ev: LkWebhookEvent): Promise<void> {
  if (ev.room?.name !== VOICE_ROOM) return;
  if (!firstDelivery(ev.id)) return;
  const identity = ev.participant?.identity ?? null;
  const sid = ev.room?.sid ?? null;
  switch (ev.event) {
    case "participant_joined": {
      // Banned after the token was issued: remove at once (tokens are short, but not zero).
      if (identity && (await isUserIdBanned(identity))) {
        const cfg = livekitConfig();
        if (cfg) await removeParticipant(cfg, identity).catch(() => {});
        break;
      }
      // A session left open from an earlier LiveKit room (missed room_finished) ends here.
      if (sid) await closeOpenSessions(sid);
      // The first person into an empty room opens a session. The unique index on open
      // sessions makes a simultaneous second insert a no-op.
      await pool.query(
        `INSERT INTO voice_sessions (livekit_sid, opened_by) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [sid, identity]
      );
      if (identity) {
        await pool.query(
          `INSERT INTO voice_participations (session_id, user_id)
           SELECT s.id, $1 FROM voice_sessions s
           WHERE s.ended_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM voice_participations p
                             WHERE p.session_id = s.id AND p.user_id = $1 AND p.left_at IS NULL)
           LIMIT 1`,
          [identity]
        );
      }
      break;
    }
    case "participant_left":
      if (identity) {
        await pool.query(
          `UPDATE voice_participations SET left_at = now()
           WHERE user_id = $1 AND left_at IS NULL
             AND session_id IN (SELECT id FROM voice_sessions WHERE $2::text IS NULL OR livekit_sid = $2)`,
          [identity, sid]
        );
      }
      break;
    case "room_finished":
      // Only the session of this LiveKit room (a stale or replayed event must not end a newer one).
      if (sid) {
        const r = await pool.query(
          `UPDATE voice_sessions SET ended_at = now() WHERE ended_at IS NULL AND livekit_sid = $1 RETURNING id`,
          [sid]
        );
        if ((r.rowCount ?? 0) > 0) {
          await pool.query(
            `UPDATE voice_participations SET left_at = now() WHERE left_at IS NULL AND session_id = ANY($1::int[])`,
            [r.rows.map((row) => row.id)]
          );
        }
      }
      break;
    default:
      return;
  }
  await refreshVoiceState().catch((e) => console.error("[voice] refresh after webhook:", (e as Error)?.message));
}

export async function purgeOldVoiceLog(): Promise<number> {
  await pool.query(`DELETE FROM voice_mod_log WHERE created_at < now() - interval '365 days'`);
  await pool.query(`DELETE FROM voice_reports WHERE created_at < now() - interval '365 days'`);
  await pool.query(
    `DELETE FROM voice_participations WHERE joined_at < now() - interval '30 days'`
  );
  const r = await pool.query(
    `DELETE FROM voice_sessions WHERE started_at < now() - interval '30 days' AND ended_at IS NOT NULL`
  );
  return r.rowCount ?? 0;
}

// ---- moderation ----

/** Only admins moderate (remove / mute / ban). With the room open to every
 *  member, letting whoever opened it remove others invited repeated kicking. */
export async function canModerate(email: string): Promise<boolean> {
  return isAdmin(email);
}

export function isOpenerPresent(state: VoiceState, userId: string): boolean {
  return state.active && state.openedBy === userId && state.participants.some((p) => p.userId === userId);
}

export async function removeParticipant(cfg: LiveKitConfig, userId: string): Promise<void> {
  await roomService(cfg, "RemoveParticipant", { room: VOICE_ROOM, identity: userId }, VOICE_ROOM);
}

/** Turn someone's mic off from the server (they can turn it back on, but an
 *  admin can repeat this or remove them). Returns false when they have no mic track. */
export async function muteParticipant(cfg: LiveKitConfig, userId: string): Promise<boolean> {
  const res = await roomService<{ participants?: { identity?: string; tracks?: { sid?: string; type?: string | number; source?: string | number; muted?: boolean }[] }[] }>(
    cfg, "ListParticipants", { room: VOICE_ROOM }, VOICE_ROOM
  );
  const p = (res?.participants ?? []).find((x) => x.identity === userId);
  const mics = (p?.tracks ?? []).filter((t) => t.sid && !t.muted && (t.type === "AUDIO" || t.type === 0));
  for (const t of mics) {
    await roomService(cfg, "MutePublishedTrack", { room: VOICE_ROOM, identity: userId, track_sid: t.sid, muted: true }, VOICE_ROOM);
  }
  return mics.length > 0;
}

/** Who removed / muted / banned whom, and when (kept a year). */
export async function logModeration(actorEmail: string, action: "kick" | "ban" | "mute" | "unban", targetUserId: string, reason: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO voice_mod_log (actor_email, action, target_user_id, reason) VALUES ($1, $2, $3, $4)`,
    [actorEmail, action, targetUserId, reason]
  );
}

export async function banFromVoice(email: string, bannedBy: string, reason: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO voice_bans (email, banned_by, reason) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET banned_by = EXCLUDED.banned_by, reason = EXCLUDED.reason, created_at = now()`,
    [email.trim().toLowerCase(), bannedBy, reason]
  );
}

// ---- speaker cap, enforced by the server ----
//
// The apps and the web check the cap before unmuting; this catches everyone else
// (older app versions, a modified client): while the room is in use it counts the
// unmuted mics every few seconds and mutes whoever went over the cap most recently.

type Guard = { timer: ReturnType<typeof setInterval> | null; since: Map<string, number>; busy: boolean };
const gg = globalThis as unknown as { __voiceGuard?: Guard };
const guard: Guard = (gg.__voiceGuard ??= { timer: null, since: new Map(), busy: false });
const GUARD_MS = 3000;

interface LkTrack { sid?: string; type?: string | number; muted?: boolean }
interface LkParticipantFull { identity?: string; tracks?: LkTrack[] }

const isLiveMic = (t: LkTrack) => !!t.sid && !t.muted && (t.type === "AUDIO" || t.type === 0);

/** Pure part (tested): who must be muted, given who has a live mic now and when
 *  each of them was first seen talking. Keeps the earliest `max`. */
export function overCap(speakers: string[], since: Map<string, number>, max: number, now: number): string[] {
  for (const id of speakers) if (!since.has(id)) since.set(id, now);
  for (const id of Array.from(since.keys())) if (!speakers.includes(id)) since.delete(id);
  if (speakers.length <= max) return [];
  const order = [...speakers].sort((a, b) => (since.get(a)! - since.get(b)!) || a.localeCompare(b));
  return order.slice(max);
}

export async function enforceSpeakerCap(): Promise<number> {
  const cfg = livekitConfig();
  if (!cfg || guard.busy) return 0;
  guard.busy = true;
  try {
    const res = await roomService<{ participants?: LkParticipantFull[] }>(cfg, "ListParticipants", { room: VOICE_ROOM }, VOICE_ROOM);
    const people = res?.participants ?? [];
    if (people.length === 0) {
      stopSpeakerGuard();
      return 0;
    }
    const speakers = people.filter((p) => p.identity && (p.tracks ?? []).some(isLiveMic)).map((p) => p.identity!);
    const extra = overCap(speakers, guard.since, VOICE_MAX_SPEAKERS, Date.now());
    for (const id of extra) {
      const p = people.find((x) => x.identity === id);
      for (const t of (p?.tracks ?? []).filter(isLiveMic)) {
        await roomService(cfg, "MutePublishedTrack", { room: VOICE_ROOM, identity: id, track_sid: t.sid, muted: true }, VOICE_ROOM);
      }
      guard.since.delete(id);
    }
    if (extra.length) console.log(`[voice] speaker cap: muted ${extra.length}`);
    return extra.length;
  } finally {
    guard.busy = false;
  }
}

export function ensureSpeakerGuard(): void {
  if (guard.timer || !livekitConfig()) return;
  guard.timer = setInterval(() => {
    enforceSpeakerCap().catch((e) => console.error("[voice] speaker guard:", (e as Error)?.message));
  }, GUARD_MS);
  guard.timer.unref?.();
}

function stopSpeakerGuard(): void {
  if (guard.timer) clearInterval(guard.timer);
  guard.timer = null;
  guard.since.clear();
}

// ---- reports and bans (admins) ----

export async function recordReport(reporterEmail: string, targetUserId: string, reason: string | null): Promise<number> {
  const r = await pool.query(
    `INSERT INTO voice_reports (reporter_email, target_user_id, reason) VALUES ($1, $2, $3) RETURNING id`,
    [reporterEmail, targetUserId, reason]
  );
  return r.rows[0].id as number;
}

/** Reports by this member in the last hour (abuse guard for the report button). */
export async function recentReports(reporterEmail: string): Promise<number> {
  const r = await pool.query(
    `SELECT count(*)::int AS n FROM voice_reports WHERE reporter_email = $1 AND created_at > now() - interval '1 hour'`,
    [reporterEmail]
  );
  return r.rows[0].n as number;
}

export interface VoiceBan {
  userId: string | null;
  name: string | null;
  reason: string | null;
  bannedAt: string;
}

export async function listBans(): Promise<VoiceBan[]> {
  const r = await pool.query(
    `SELECT b.email, b.reason, b.created_at, u.user_id FROM voice_bans b LEFT JOIN users u ON u.email = b.email ORDER BY b.created_at DESC`
  );
  const names = await resolveDisplayNames(r.rows.map((x) => x.email as string));
  return r.rows.map((x) => ({
    userId: (x.user_id as string) ?? null,
    name: names.get(x.email as string) ?? null,
    reason: (x.reason as string) ?? null,
    bannedAt: new Date(x.created_at).toISOString(),
  }));
}

export async function unban(email: string): Promise<boolean> {
  const r = await pool.query(`DELETE FROM voice_bans WHERE email = $1`, [email.trim().toLowerCase()]);
  return (r.rowCount ?? 0) > 0;
}
