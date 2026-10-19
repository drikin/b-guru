/* The club room (ルーム): who is in the house, where they stand, and what they are
 * doing — the state behind the 8-bit room view and its proximity voice.
 *
 * Single pm2 process, so the state is in memory (on globalThis, shared by every
 * route bundle); only each member's last position is kept in the DB so coming back
 * puts you where you were. Everyone with B-guru open (web tab or app) is "in the
 * house": in room view they walk around; in text view they sit at a chat seat.
 * Changes go out over the live bus (web SSE and the apps' stream) as `room` events.
 *
 * Voice runs in the same LiveKit room as before. Who may hear whom follows
 * audibility() in room-map.ts; each app restricts its own microphone track to the
 * people allowed to hear it (LiveKit track permissions), so a modified client
 * cannot listen in on the meeting table. The server decides who may turn the mic
 * on (speaker limits per circle and on the stage).
 *
 * Privacy: events carry opaque user ids and display names only, never emails. */
import { pool } from "./db";
import { emitLive } from "./live";
import { resolveDisplayNames } from "./display-name";
import { gravatarUrl } from "./posts";
import { ensureUserId } from "./user";
import { livekitConfig } from "./livekit";
import { getVoiceState } from "./voice";
import { ROOM_DOOR, ROOM_SEATS, audibility, walkable, zoneAt } from "./room-map";

export type RoomMode = "room" | "text";

export interface RoomMember {
  userId: string;
  name: string;
  avatar: string;
  x: number;
  y: number;
  mode: RoomMode;
  /** In the voice (room view, not "見るだけ"). */
  listening: boolean;
  mic: boolean;
  /** No input for a while (💤). */
  away: boolean;
}

interface Entry extends RoomMember {
  email: string;
  conns: number;
  lastActive: number;
  /** Removal scheduled after the last connection closed (grace for reconnects). */
  leaveTimer: ReturnType<typeof setTimeout> | null;
  moves: number[];
}

/** Speakers one listener can have at once (people with the mic on that they hear). */
export const RING_MAX_SPEAKERS = 8;
/** People on the stage with the mic on at once. */
export const STAGE_MAX_SPEAKERS = 3;
const LEAVE_GRACE_MS = 30_000;
const AWAY_AFTER_MS = 10 * 60_000;
const MIC_OFF_AFTER_MS = 30 * 60_000;
const MAX_MOVES_PER_SEC = 12;

type G = { __room?: Map<string, Entry>; __roomSweep?: ReturnType<typeof setInterval> };
const g = globalThis as unknown as G;
const members = (g.__room ??= new Map<string, Entry>());

/** The room is on for this member (rollout: ROOM_ALLOW_EMAILS; unset = nobody yet). */
export function roomEnabledFor(email: string | null | undefined): boolean {
  if (!email || !livekitConfig()) return false;
  const raw = process.env.ROOM_ALLOW_EMAILS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim().toLowerCase()).includes(email.trim().toLowerCase());
}

const key = (email: string) => email.trim().toLowerCase();
const publicOf = (e: Entry): RoomMember => ({
  userId: e.userId,
  name: e.name,
  avatar: e.avatar,
  x: e.x,
  y: e.y,
  mode: e.mode,
  listening: e.listening,
  mic: e.mic,
  away: e.away,
});

export function roomSnapshot(): RoomMember[] {
  return [...members.values()].map(publicOf);
}

function emit(action: "join" | "update" | "leave", e: Entry): void {
  emitLive({ type: "room", action, member: publicOf(e) });
}

function freeSeat(except?: Entry): { x: number; y: number } {
  const taken = new Set([...members.values()].filter((m) => m !== except && m.mode === "text").map((m) => `${m.x},${m.y}`));
  return ROOM_SEATS.find((s) => !taken.has(`${s.x},${s.y}`)) ?? ROOM_SEATS[ROOM_SEATS.length - 1];
}

/** A web tab or app opened its live stream: the member is in the house (text view
 *  until they switch to the room). Idempotent per connection. */
export async function roomConnect(email: string): Promise<void> {
  if (!roomEnabledFor(email)) return;
  const k = key(email);
  const cur = members.get(k);
  if (cur) {
    cur.conns += 1;
    if (cur.leaveTimer) {
      clearTimeout(cur.leaveTimer);
      cur.leaveTimer = null;
    }
    return;
  }
  const [userId, names] = await Promise.all([ensureUserId(email), resolveDisplayNames([email])]);
  if (members.has(k)) return roomConnect(email); // raced with another connection
  const e: Entry = {
    email,
    userId,
    name: names.get(email) || email.split("@")[0],
    avatar: gravatarUrl(email),
    x: 0,
    y: 0,
    mode: "text",
    listening: false,
    mic: false,
    away: false,
    conns: 1,
    lastActive: Date.now(),
    leaveTimer: null,
    moves: [],
  };
  const seat = freeSeat();
  e.x = seat.x;
  e.y = seat.y;
  members.set(k, e);
  ensureRoomSweeper();
  emit("join", e);
}

/** A live stream closed. The member leaves after a short grace (reconnects, reloads). */
export function roomDisconnect(email: string): void {
  const e = members.get(key(email));
  if (!e) return;
  e.conns = Math.max(0, e.conns - 1);
  if (e.conns > 0 || e.leaveTimer) return;
  const check = async () => {
    e.leaveTimer = null;
    if (e.conns > 0) return;
    // The apps close their stream in the background, but a call goes on there (screen
    // off, another app in front): while you are in the voice you stay in the room.
    if (e.mode === "room" && e.listening) {
      const inVoice = await getVoiceState()
        .then((v) => v.participants.some((p) => p.userId === e.userId))
        .catch(() => false);
      if (inVoice && members.get(key(email)) === e) {
        e.leaveTimer = setTimeout(() => void check(), LEAVE_GRACE_MS);
        return;
      }
    }
    if (e.conns > 0 || members.get(key(email)) !== e) return;
    members.delete(key(email));
    if (e.mode === "room") void saveLastPosition(e);
    emit("leave", e);
  };
  e.leaveTimer = setTimeout(() => void check(), LEAVE_GRACE_MS);
}

async function saveLastPosition(e: Entry): Promise<void> {
  await pool
    .query(
      `INSERT INTO room_positions (email, x, y, updated_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (email) DO UPDATE SET x = EXCLUDED.x, y = EXCLUDED.y, updated_at = now()`,
      [key(e.email), e.x, e.y]
    )
    .catch((err) => console.error("[room] save position:", (err as Error)?.message));
}

async function lastPosition(email: string): Promise<{ x: number; y: number } | null> {
  const r = await pool.query(
    `SELECT x, y FROM room_positions WHERE email = $1 AND updated_at > now() - interval '12 hours'`,
    [key(email)]
  );
  const row = r.rows[0];
  return row && walkable(row.x, row.y) ? { x: row.x, y: row.y } : null;
}

type Result = { ok: true; member: RoomMember; from?: { x: number; y: number }; to?: { x: number; y: number } } | { ok: false; status: number; error: string };

function entryFor(email: string): Entry | null {
  return members.get(key(email)) ?? null;
}

const notInHouse = { ok: false as const, status: 409, error: "部室に接続していません（ページかアプリを開き直してください）" };

/** Switch to the room view: appear at the door and walk to where you were last time
 *  (the client animates the walk). In the voice unless `listening` is false. */
export async function roomEnter(email: string, listening = true): Promise<Result> {
  const e = entryFor(email);
  if (!e) return notInHouse;
  if (tooFast(e)) return slowDown;
  touch(e);
  if (e.mode === "room") return { ok: true, member: publicOf(e) };
  const target = (await lastPosition(email)) ?? { x: ROOM_DOOR.x, y: ROOM_DOOR.y - 2 };
  e.mode = "room";
  e.x = target.x;
  e.y = target.y;
  e.listening = listening;
  e.mic = false;
  emit("update", e);
  return { ok: true, member: publicOf(e), from: { ...ROOM_DOOR }, to: target };
}

/** Back to the text view: out of the voice, sitting at a chat seat. */
export function roomToText(email: string): Result {
  const e = entryFor(email);
  if (!e) return notInHouse;
  if (tooFast(e)) return slowDown;
  touch(e);
  if (e.mode === "room") void saveLastPosition(e);
  const seat = freeSeat(e);
  e.mode = "text";
  e.listening = false;
  e.mic = false;
  e.x = seat.x;
  e.y = seat.y;
  emit("update", e);
  return { ok: true, member: publicOf(e) };
}

/** One step (or a short skip after a dropped step): at most 2 tiles from where the
 *  server has you, onto a walkable, free tile. Rate limited. */
export function roomMove(email: string, x: unknown, y: unknown): Result {
  const e = entryFor(email);
  if (!e) return notInHouse;
  if (e.mode !== "room") return { ok: false, status: 409, error: "ルームに入っていません" };
  if (typeof x !== "number" || typeof y !== "number" || !walkable(x, y)) return { ok: false, status: 400, error: "そこへは行けません" };
  if (tooFast(e)) return slowDown;
  if (Math.abs(x - e.x) + Math.abs(y - e.y) > 2) return { ok: false, status: 400, error: "離れすぎています" };
  for (const m of members.values()) if (m !== e && m.mode === "room" && m.x === x && m.y === y) return { ok: false, status: 409, error: "人がいます" };
  touch(e);
  e.x = x;
  e.y = y;
  // Walking onto the stage or out of earshot can push you over a speaker limit.
  if (e.mic && !micAllowed(e).ok) e.mic = false;
  emit("update", e);
  return { ok: true, member: publicOf(e) };
}

/** Speaker limits: on the stage at most STAGE_MAX_SPEAKERS; elsewhere nobody who
 *  would hear you may end up hearing more than RING_MAX_SPEAKERS people at once. */
export function micAllowed(e: RoomMember): { ok: true } | { ok: false; error: string } {
  const talking = [...members.values()].filter((m) => m.userId !== e.userId && m.mode === "room" && m.mic);
  if (zoneAt(e.x, e.y)?.kind === "stage") {
    const onStage = talking.filter((m) => zoneAt(m.x, m.y)?.kind === "stage").length;
    return onStage >= STAGE_MAX_SPEAKERS ? { ok: false, error: `ステージで話せるのは同時に ${STAGE_MAX_SPEAKERS} 人までです` } : { ok: true };
  }
  const listeners = [...members.values()].filter((m) => m.mode === "room" && m.listening && m.userId !== e.userId && audibility(m, e) > 0);
  for (const l of listeners) {
    const heard = talking.filter((t) => t.userId !== l.userId && audibility(l, t) > 0).length;
    if (heard >= RING_MAX_SPEAKERS) return { ok: false, error: `この輪で話せるのは同時に ${RING_MAX_SPEAKERS} 人までです。少し離れるか、誰かがマイクを切るまでお待ちください` };
  }
  return { ok: true };
}

/** Listening (👀 見るだけ when false) and the mic. Turning the mic on needs the voice. */
export function roomVoice(email: string, input: { listening?: unknown; mic?: unknown }): Result {
  const e = entryFor(email);
  if (!e) return notInHouse;
  if (e.mode !== "room") return { ok: false, status: 409, error: "ルームに入っていません" };
  if (tooFast(e)) return slowDown;
  touch(e);
  if (typeof input.listening === "boolean") {
    e.listening = input.listening;
    if (!e.listening) e.mic = false;
  }
  if (input.mic === true && !e.mic) {
    if (!e.listening) return { ok: false, status: 409, error: "見るだけの間はマイクを使えません" };
    const allowed = micAllowed(e);
    if (!allowed.ok) return { ok: false, status: 429, error: allowed.error };
    e.mic = true;
  } else if (input.mic === false) {
    e.mic = false;
  }
  emit("update", e);
  return { ok: true, member: publicOf(e) };
}

export const ROOM_REACTIONS = ["👋", "❤️", "😂", "👏", "🎉", "🍻"];

/** An emoji over your head (not stored, not notified). `to`: a wave at someone. */
export function roomReact(email: string, emoji: unknown, to?: unknown): { ok: true } | { ok: false; status: number; error: string } {
  const e = entryFor(email);
  if (!e) return notInHouse;
  if (typeof emoji !== "string" || !ROOM_REACTIONS.includes(emoji)) return { ok: false, status: 400, error: "使えないリアクションです" };
  if (tooFast(e)) return slowDown;
  touch(e);
  const target = typeof to === "string" && [...members.values()].some((m) => m.userId === to) ? to : null;
  emitLive({ type: "room", action: "react", userId: e.userId, emoji, to: target });
  return { ok: true };
}

/** Every room action counts toward one per-member limit (MAX_MOVES_PER_SEC). */
function tooFast(e: Entry): boolean {
  const now = Date.now();
  e.moves = e.moves.filter((t) => now - t < 1000);
  if (e.moves.length >= MAX_MOVES_PER_SEC) return true;
  e.moves.push(now);
  return false;
}
const slowDown = { ok: false as const, status: 429, error: "速すぎます" };

function touch(e: Entry): void {
  e.lastActive = Date.now();
  if (e.away) {
    e.away = false;
    emit("update", e);
  }
}

/** 💤 after 10 min without input; the mic goes off after 30 (a forgotten open mic). */
export function sweepRoom(now = Date.now()): void {
  for (const e of members.values()) {
    const idle = now - e.lastActive;
    let changed = false;
    if (!e.away && idle > AWAY_AFTER_MS) {
      e.away = true;
      changed = true;
    }
    if (e.mic && idle > MIC_OFF_AFTER_MS) {
      e.mic = false;
      changed = true;
    }
    if (changed) emit("update", e);
  }
}

function ensureRoomSweeper(): void {
  if (g.__roomSweep) return;
  g.__roomSweep = setInterval(() => sweepRoom(), 60_000);
  g.__roomSweep.unref?.();
}

/** Tests only. */
export function __resetRoomForTests(): void {
  for (const e of members.values()) if (e.leaveTimer) clearTimeout(e.leaveTimer);
  members.clear();
}
