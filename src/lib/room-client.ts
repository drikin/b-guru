"use client";
/* Web club room (ルーム) client store. Like voice-client.ts it lives outside React
 * (one per tab, survives switching tabs) and components read it through
 * useSyncExternalStore (subscribe / getSnapshot).
 *
 *   loadRoom()       GET /api/room — 200 = on (map + members), 404 = off (the old
 *                    voice bar stays, nothing changes).
 *   applyRoomEvent() the `room` SSE event (join / update / leave / react).
 *   actions          enter / text / move / voice / react via POST /api/room.
 *
 * Positions: the snapshot's members carry the server truth (and my own position
 * as I walk). The canvas reads the animated "actors" (getActors) and calls
 * tickRoom() every frame: I walk my own path one tile per STEP_MS and POST each
 * step without waiting (a refusal re-syncs from the server); everyone else is
 * walked tile by tile toward their latest position; whoever comes into the room
 * walks in from the door.
 *
 * Voice: entering the room = joinVoice() muted (unless 見るだけ); text view or
 * 見るだけ = leaveVoice(). After every change the proximity (volumes + who may
 * receive my mic) goes to voice-client. The mic: the server first, then LiveKit. */
import {
  bfsPath,
  allowedListeners,
  isWalkable,
  volumesFor,
  DIRS,
  type Dir,
  type RoomMapDto,
  type RoomMember,
} from "./room-logic";
import {
  getSnapshot as getVoiceSnapshot,
  joinVoice,
  leaveVoice,
  setMic,
  setRoomProximity,
  setVoiceHooks,
  subscribe as subscribeVoice,
  voiceMovedAway,
} from "./voice-client";

export type RoomStatus = "unknown" | "enabled" | "disabled";
export type RoomView = "text" | "room";

export interface RoomSnapshot {
  status: RoomStatus;
  map: RoomMapDto | null;
  me: string | null;
  members: RoomMember[];
  reactions: string[];
  /** This tab's view. Always starts in text (sound needs a user gesture). */
  view: RoomView;
  /** My 🎧 / 👀 choice, used when entering. */
  wantListening: boolean;
  /** An enter / text / voice request is on its way. */
  busy: boolean;
  notice: string | null;
}

export interface Actor {
  id: string;
  /** Logical tile (where it is going / has arrived). */
  x: number;
  y: number;
  /** Drawn position (tiles, fractional while walking). */
  fx: number;
  fy: number;
  moving: { fromX: number; fromY: number; t: number } | null;
  dir: "up" | "down" | "side";
  flip: boolean;
  path: Dir[];
  /** Others: where the server last put them. */
  target: { x: number; y: number } | null;
  bubble: { text: string; until: number } | null;
  reacts: { e: string; t0: number; small?: boolean }[];
}

export const STEP_MS = 170;
/** Farther than this (in steps) and a member just appears at the new spot. */
const MAX_TWEEN_STEPS = 10;
const BUBBLE_MS = 4500;
/** After I ask for the mic, ignore older "mic: false" echoes for this long. */
const MIC_GRACE_MS = 2000;

let snap: RoomSnapshot = {
  status: "unknown",
  map: null,
  me: null,
  members: [],
  reactions: ["👋", "❤️", "😂", "👏", "🎉", "🍻"],
  view: "text",
  wantListening: readListening(),
  busy: false,
  notice: null,
};
const SERVER_SNAPSHOT = snap;
const listeners = new Set<() => void>();
const actors = new Map<string, Actor>();
/** Held direction keys / D-pad buttons, last pressed wins. */
const held: Dir[] = [];
/** I am walking in from the door: the server already has me at the target. */
let entryTarget: { x: number; y: number } | null = null;
let micAskedAt = 0;
let loading: Promise<void> | null = null;
let resyncing = false;
/** We are in (or joining) the voice on purpose; a drop otherwise means 見るだけ. */
let expectVoice = false;
let lastVoicePhase = getVoiceSnapshot().phase;

function set(patch: Partial<RoomSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
  syncVoice();
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getSnapshot(): RoomSnapshot {
  return snap;
}
export function getServerSnapshot(): RoomSnapshot {
  return SERVER_SNAPSHOT;
}
export function getActors(): ReadonlyMap<string, Actor> {
  return actors;
}
export function myMember(s: RoomSnapshot = snap): RoomMember | null {
  return s.members.find((m) => m.userId === s.me) ?? null;
}
export function roomActive(s: RoomSnapshot = snap): boolean {
  return s.status === "enabled" && s.view === "room";
}

// ---- server ----

async function post(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (r.status === 404 && data?.code === "room_disabled") disableRoom();
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "通信できませんでした" } };
  }
}

/** GET /api/room and replace what we know. Safe to call any time (reconnects). */
export function loadRoom(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const r = await fetch("/api/room", { cache: "no-store" });
      if (r.status === 404) {
        disableRoom();
        return;
      }
      if (!r.ok) return; // signed out / offline: keep what we have
      const d = await r.json();
      applySnapshot(d.map as RoomMapDto, d.me as string, (d.members ?? []) as RoomMember[], d.reactions);
    } catch {
      /* offline: the next stream reconnect retries */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Reload only if the room is (or may be) on — for SSE reconnects. */
export function reloadRoomIfOn(): void {
  if (snap.status !== "disabled") void loadRoom();
}

function disableRoom() {
  if (snap.view === "room") void leaveVoice();
  expectVoice = false;
  actors.clear();
  setVoiceHooks(null);
  setRoomProximity(null);
  set({ status: "disabled", view: "text", members: [] });
}

function applySnapshot(map: RoomMapDto, me: string, members: RoomMember[], reactions?: unknown) {
  const seen = new Set<string>();
  for (const m of members) {
    seen.add(m.userId);
    const a = actors.get(m.userId);
    if (!a) {
      actors.set(m.userId, newActor(m.userId, m.x, m.y));
    } else if (m.userId === me) {
      // Re-sync: the server's position wins for me.
      if (!entryTarget || m.mode !== "room") placeAt(a, m.x, m.y);
    } else {
      a.target = { x: m.x, y: m.y };
      if (m.mode === "text") placeAt(a, m.x, m.y);
    }
  }
  for (const id of [...actors.keys()]) if (!seen.has(id)) actors.delete(id);
  const mine = members.find((m) => m.userId === me);
  // Another tab or device moved me back to the text view.
  const view = snap.view === "room" && mine && mine.mode === "text" && !snap.busy ? "text" : snap.view;
  if (view !== snap.view) {
    expectVoice = false;
    void leaveVoice();
  }
  set({
    status: "enabled",
    map,
    me,
    members,
    view,
    reactions: Array.isArray(reactions) && reactions.length ? (reactions as string[]) : snap.reactions,
  });
  if (mine) followServerMic(mine);
}

async function resync() {
  if (resyncing) return;
  resyncing = true;
  const me = actors.get(snap.me ?? "");
  if (me) {
    me.path = [];
    entryTarget = null;
  }
  await loadRoom();
  resyncing = false;
}

// ---- live events ----

type RoomEvent =
  | { type?: "room"; action: "join" | "update" | "leave"; member: RoomMember }
  | { type?: "room"; action: "react"; userId: string; emoji: string; to: string | null };

/** The `room` event of /api/posts/stream. */
export function applyRoomEvent(ev: RoomEvent): void {
  if (snap.status !== "enabled" || !snap.map) return;
  if (ev.action === "react") {
    const now = performance.now();
    actors.get(ev.userId)?.reacts.push({ e: ev.emoji, t0: now });
    if (ev.to) actors.get(ev.to)?.reacts.push({ e: "👋", t0: now, small: true });
    listeners.forEach((l) => l());
    return;
  }
  const m = ev.member;
  if (!m?.userId) return;
  if (ev.action === "leave") {
    actors.delete(m.userId);
    set({ members: snap.members.filter((x) => x.userId !== m.userId) });
    return;
  }
  const prev = snap.members.find((x) => x.userId === m.userId) ?? null;
  const isMe = m.userId === snap.me;
  let a = actors.get(m.userId);
  if (!a) {
    a = newActor(m.userId, m.x, m.y);
    actors.set(m.userId, a);
  }
  let next = m;
  let view = snap.view;
  if (isMe) {
    if (m.mode === "text") {
      placeAt(a, m.x, m.y);
      entryTarget = null;
      if (snap.view === "room" && !snap.busy) {
        // Another tab or the app took me back to the text view.
        view = "text";
        expectVoice = false;
        void leaveVoice();
      }
    } else if (prev?.mode === "room") {
      // While I walk, my own position is mine: the echoes of my steps lag behind.
      next = { ...m, x: prev.x, y: prev.y };
    }
  } else {
    moveOther(a, prev, m);
  }
  const members = prev ? snap.members.map((x) => (x.userId === m.userId ? next : x)) : [...snap.members, next];
  set({ members, view });
  if (isMe) followServerMic(m);
}

function moveOther(a: Actor, prev: RoomMember | null, m: RoomMember) {
  const map = snap.map!;
  if (m.mode === "text") {
    placeAt(a, m.x, m.y);
    a.target = null;
    return;
  }
  if (prev && prev.mode === "text") {
    // Came into the room: walk in from the door.
    placeAt(a, map.door.x, map.door.y);
    a.dir = "up";
    a.path = bfsPath(map.tiles, map.door, { x: m.x, y: m.y });
    if (!a.path.length) placeAt(a, m.x, m.y);
    a.target = { x: m.x, y: m.y };
    return;
  }
  a.path = [];
  a.target = { x: m.x, y: m.y };
}

// ---- actions ----

/** テキスト｜ルーム. Entering joins the voice muted (unless 👀 見るだけ). */
export async function setRoomView(view: RoomView): Promise<void> {
  if (snap.status !== "enabled" || snap.busy || view === snap.view) return;
  if (view === "room") await enterRoom();
  else await toText();
}

async function enterRoom() {
  const listening = snap.wantListening;
  set({ busy: true, notice: null, view: "room" });
  const r = await post({ action: "enter", listening });
  if (!r.ok) {
    set({ busy: false, view: "text", notice: (r.data.error as string) ?? "ルームに入れませんでした" });
    return;
  }
  const member = r.data.member as RoomMember;
  const from = r.data.from as { x: number; y: number } | undefined;
  const to = r.data.to as { x: number; y: number } | undefined;
  const a = actors.get(member.userId) ?? newActor(member.userId, member.x, member.y);
  actors.set(member.userId, a);
  if (from && to && snap.map) {
    placeAt(a, from.x, from.y);
    a.dir = "up";
    a.path = bfsPath(snap.map.tiles, from, to, blockedFor(member.userId));
    entryTarget = a.path.length ? { ...to } : null;
    if (!a.path.length) placeAt(a, to.x, to.y);
  } else {
    placeAt(a, member.x, member.y);
  }
  upsertMe(member);
  installHooks();
  set({ busy: false });
  if (member.listening) {
    expectVoice = true;
    syncVoice();
    await joinVoiceForRoom();
  }
}

async function toText() {
  set({ busy: true, notice: null });
  expectVoice = false;
  if (getVoiceSnapshot().micOn) await setMic(false);
  await leaveVoice();
  const r = await post({ action: "text" });
  entryTarget = null;
  held.length = 0;
  const me = actors.get(snap.me ?? "");
  if (me) me.path = [];
  if (r.ok) {
    const member = r.data.member as RoomMember;
    if (me) placeAt(me, member.x, member.y);
    upsertMe(member);
  }
  setVoiceHooks(null);
  set({ busy: false, view: "text" });
}

/** 🎧 聞いている ⇄ 👀 見るだけ (remembered per browser, like the apps). */
export async function setListening(listening: boolean): Promise<void> {
  if (snap.busy) return;
  set({ wantListening: listening });
  saveListening(listening);
  if (!roomActive()) return;
  set({ busy: true, notice: null });
  if (!listening) {
    expectVoice = false;
    if (getVoiceSnapshot().micOn) await setMic(false);
    await leaveVoice();
  }
  const r = await post({ action: "voice", listening });
  if (r.ok) upsertMe(r.data.member as RoomMember);
  else set({ notice: (r.data.error as string) ?? "切り替えられませんでした" });
  set({ busy: false });
  if (listening && r.ok) {
    expectVoice = true;
    await joinVoiceForRoom();
  }
}

/** joinVoice(), and if we end up outside the voice anyway (voice off for this
 *  member, token refused, no connection) fall back to 👀 見るだけ. */
async function joinVoiceForRoom() {
  await joinVoice();
  if (expectVoice && roomActive() && getVoiceSnapshot().phase === "idle") voiceDropped();
}

const LS_LISTENING = "bguru-room-listening";
function readListening(): boolean {
  try {
    return typeof localStorage === "undefined" || localStorage.getItem(LS_LISTENING) !== "0";
  } catch {
    return true;
  }
}
function saveListening(on: boolean) {
  try {
    localStorage.setItem(LS_LISTENING, on ? "1" : "0");
  } catch {
    /* private mode: just not remembered */
  }
}

function voiceDropped() {
  expectVoice = false;
  set({ wantListening: false, notice: getVoiceSnapshot().notice ?? "ボイスにつながりませんでした（見るだけにしました）" });
  void post({ action: "voice", listening: false }).then((r) => {
    if (r.ok) upsertMe(r.data.member as RoomMember);
  });
}

/** The mic: the server first (speaker limits), then LiveKit. */
export async function setRoomMic(on: boolean): Promise<void> {
  if (!roomActive()) return;
  if (on) {
    micAskedAt = Date.now();
    const r = await post({ action: "voice", mic: true });
    if (!r.ok) {
      set({ notice: (r.data.error as string) ?? "マイクをオンにできませんでした" });
      return;
    }
    set({ notice: null });
    upsertMe(r.data.member as RoomMember);
    await setMic(true);
    // The browser refused the microphone: tell the server it stays off.
    if (!getVoiceSnapshot().micOn) {
      const off = await post({ action: "voice", mic: false });
      if (off.ok) upsertMe(off.data.member as RoomMember);
    }
  } else {
    micAskedAt = 0;
    await setMic(false);
    const r = await post({ action: "voice", mic: false });
    if (r.ok) upsertMe(r.data.member as RoomMember);
  }
}

export async function sendReaction(emoji: string, to?: string): Promise<void> {
  if (!roomActive()) return;
  // Shown when the server's react event comes back (to everyone, me included).
  const r = await post({ action: "react", emoji, ...(to ? { to } : {}) });
  if (!r.ok && r.status === 429) set({ notice: (r.data.error as string) ?? "速すぎます" });
}

/** Walk to a tile (furniture or a person: to the free tile next to it;
 *  `beside`: always next to it, for 「そばへ行く」). */
export function walkTo(x: number, y: number, beside = false): void {
  const map = snap.map;
  const me = actors.get(snap.me ?? "");
  if (!map || !me || !roomActive()) return;
  finishEntry(me);
  const blocked = blockedFor(me.id);
  let target = { x, y };
  if (beside || !isWalkable(map.tiles, x, y) || blocked(x, y)) {
    const near = Object.values(DIRS)
      .map(([dx, dy]) => ({ x: x + dx, y: y + dy }))
      .filter((p) => (p.x === me.x && p.y === me.y) || (isWalkable(map.tiles, p.x, p.y) && !blocked(p.x, p.y)))
      .sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    if (!near.length) return;
    target = near[0];
  }
  me.path = bfsPath(map.tiles, { x: me.x, y: me.y }, target, blocked);
}

/** Arrow keys / WASD / D-pad. */
export function pressDir(d: Dir): void {
  const me = actors.get(snap.me ?? "");
  if (me) {
    finishEntry(me);
    me.path = [];
  }
  const i = held.indexOf(d);
  if (i >= 0) held.splice(i, 1);
  held.push(d);
}
export function releaseDir(d?: Dir): void {
  if (!d) held.length = 0;
  else {
    const i = held.indexOf(d);
    if (i >= 0) held.splice(i, 1);
  }
}

export function clearRoomNotice(): void {
  if (snap.notice) set({ notice: null });
}

/** A chat message arrived: a bubble over its author for a few seconds. */
export function roomChatBubble(authorId: string | null | undefined, text: string | null): void {
  if (!authorId || !text || snap.status !== "enabled") return;
  const a = actors.get(authorId);
  if (a) a.bubble = { text, until: performance.now() + BUBBLE_MS };
}

// ---- per-frame movement ----

/** Advance walking by `dt` ms. Called by the map's animation loop. */
export function tickRoom(dt: number): void {
  const map = snap.map;
  if (!map) return;
  for (const a of actors.values()) {
    if (a.moving) {
      a.moving.t += dt / STEP_MS;
      if (a.moving.t >= 1) a.moving = null;
    }
    if (!a.moving) {
      if (a.id === snap.me) stepMe(a, map);
      else stepOther(a, map);
    }
    const mv = a.moving;
    a.fx = mv ? mv.fromX + (a.x - mv.fromX) * mv.t : a.x;
    a.fy = mv ? mv.fromY + (a.y - mv.fromY) * mv.t : a.y;
  }
}

function stepMe(a: Actor, map: RoomMapDto) {
  const mine = myMember();
  if (!mine || mine.mode !== "room" || snap.view !== "room") return;
  let d: Dir | undefined;
  if (held.length && !entryTarget) d = held[held.length - 1];
  else d = a.path.shift();
  if (!d) {
    if (entryTarget && a.x === entryTarget.x && a.y === entryTarget.y) entryTarget = null;
    return;
  }
  const [dx, dy] = DIRS[d];
  face(a, d);
  const nx = a.x + dx;
  const ny = a.y + dy;
  if (!isWalkable(map.tiles, nx, ny) || (!entryTarget && blockedFor(a.id)(nx, ny))) {
    a.path = [];
    return;
  }
  a.moving = { fromX: a.x, fromY: a.y, t: 0 };
  a.x = nx;
  a.y = ny;
  if (entryTarget) {
    if (!a.path.length) entryTarget = null;
    return; // the server already has me at the end of the entry walk
  }
  // My own position moves now (volumes, permissions); the server hears each step.
  upsertMe({ ...mine, x: nx, y: ny });
  void post({ action: "move", x: nx, y: ny }).then((r) => {
    if (!r.ok) void resync();
  });
}

function stepOther(a: Actor, map: RoomMapDto) {
  let d = a.path.shift();
  if (!d && a.target && (a.target.x !== a.x || a.target.y !== a.y)) {
    const p = bfsPath(map.tiles, { x: a.x, y: a.y }, a.target);
    if (!p.length || p.length > MAX_TWEEN_STEPS) {
      placeAt(a, a.target.x, a.target.y);
      return;
    }
    d = p[0];
  }
  if (!d) return;
  const [dx, dy] = DIRS[d];
  face(a, d);
  a.moving = { fromX: a.x, fromY: a.y, t: 0 };
  a.x += dx;
  a.y += dy;
}

// ---- helpers ----

function newActor(id: string, x: number, y: number): Actor {
  return { id, x, y, fx: x, fy: y, moving: null, dir: "up", flip: false, path: [], target: null, bubble: null, reacts: [] };
}

function placeAt(a: Actor, x: number, y: number) {
  a.x = x;
  a.y = y;
  a.fx = x;
  a.fy = y;
  a.moving = null;
  a.path = [];
}

function face(a: Actor, d: Dir) {
  a.dir = d === "up" ? "up" : d === "down" ? "down" : "side";
  a.flip = d === "left";
}

/** Other people in the room view stand on tiles you cannot step onto. */
function blockedFor(id: string) {
  const taken = new Set(snap.members.filter((m) => m.userId !== id && m.mode === "room").map((m) => m.y * 1000 + m.x));
  return (x: number, y: number) => taken.has(y * 1000 + x);
}

/** Cut the walk in from the door short: jump to where the server has me. */
function finishEntry(me: Actor) {
  if (!entryTarget) return;
  placeAt(me, entryTarget.x, entryTarget.y);
  entryTarget = null;
}

function upsertMe(m: RoomMember) {
  if (!m?.userId) return;
  const has = snap.members.some((x) => x.userId === m.userId);
  set({ members: has ? snap.members.map((x) => (x.userId === m.userId ? m : x)) : [...snap.members, m] });
}

/** The server turned my mic off (away 30 min, a speaker limit): follow it. */
function followServerMic(m: RoomMember) {
  const v = getVoiceSnapshot();
  if (m.mic || !v.micOn || v.micBusy || !roomActive()) return;
  const since = Date.now() - micAskedAt;
  if (since < MIC_GRACE_MS) {
    // Maybe an echo from before my request: look again when the grace is over.
    setTimeout(() => {
      const cur = myMember();
      if (cur) followServerMic(cur);
    }, MIC_GRACE_MS - since + 50);
    return;
  }
  void setMic(false);
}

function installHooks() {
  setVoiceHooks({
    mic: (on) => setRoomMic(on),
    leave: () => setListening(false),
  });
}

/** Hand the proximity to the voice client after every change. */
function syncVoice() {
  if (!roomActive()) {
    setRoomProximity(null);
    return;
  }
  const mine = myMember();
  if (!mine || mine.mode !== "room") {
    // Entering: nobody may hear me until the server has me in the room.
    setRoomProximity({ volumes: new Map(), allowed: [] });
    return;
  }
  setRoomProximity({ volumes: volumesFor(snap.me, snap.members), allowed: allowedListeners(snap.me, snap.members) });
}

// The voice dropped (kicked, network, could not join) while we meant to be in
// it: tell the server we are only watching now, so nobody counts on us hearing.
if (typeof window !== "undefined") {
  subscribeVoice(() => {
    const v = getVoiceSnapshot();
    const was = lastVoicePhase;
    lastVoicePhase = v.phase;
    if (was !== "idle" && v.phase === "idle" && expectVoice && roomActive()) {
      if (voiceMovedAway()) {
        // スマホなど別の端末で続けている: サーバの「自分」はそちらなので、ここでは何も書かない。
        expectVoice = false;
        set({ wantListening: false, notice: v.notice });
      } else voiceDropped();
    }
  });
}
