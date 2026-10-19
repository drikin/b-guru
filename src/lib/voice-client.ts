"use client";
/* Web voice room (browser only). One call per tab, kept outside React so that
 * switching between the chat and the timeline never drops it; components read
 * it through useSyncExternalStore (subscribe / getSnapshot).
 *
 * Same behaviour as the native apps (native/shared/VoiceStore.swift): enter
 * muted, the mic button flips at once and ignores taps while the mic starts,
 * a local level meter drives the "talking" look, my own face gets no ring.
 * livekit-client is loaded only when someone joins, so it costs nothing until then. */
import type { Room as LkRoom, Participant, LocalAudioTrack } from "livekit-client";
import { sameIds } from "./room-logic";

export interface VoiceRoomInfo {
  active: boolean;
  opened_by: string | null;
  started_at: string | null;
  participants: { user_id: string; name: string | null; avatar: string | null }[];
}

export interface VoiceMember {
  userId: string;
  name: string;
  avatar: string | null;
  speaking: boolean;
  muted: boolean;
  isMe: boolean;
}

export type VoicePhase = "idle" | "connecting" | "connected" | "reconnecting";

export interface DeviceChoice {
  id: string; // "" = follow the system / browser default
  name: string;
}

export interface VoiceSnapshot {
  enabled: boolean;
  admin: boolean;
  maxSpeakers: number;
  myUserId: string | null;
  roomInfo: VoiceRoomInfo | null;
  phase: VoicePhase;
  members: VoiceMember[];
  micOn: boolean;
  micBusy: boolean;
  micLevel: number; // 0…1
  notice: string | null;
  needsAudioUnlock: boolean; // the browser blocked playback until a click
  inputs: DeviceChoice[];
  outputs: DeviceChoice[]; // empty when the browser cannot pick speakers (Safari)
  inputId: string;
  outputId: string;
}

const LS_IN = "bguru-voice-input";
const LS_OUT = "bguru-voice-output";
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k) ?? "";
  } catch {
    return "";
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* private mode etc. — just not remembered */
  }
};

let snap: VoiceSnapshot = {
  enabled: false,
  admin: false,
  maxSpeakers: 10,
  myUserId: null,
  roomInfo: null,
  phase: "idle",
  members: [],
  micOn: false,
  micBusy: false,
  micLevel: 0,
  notice: null,
  needsAudioUnlock: false,
  inputs: [],
  outputs: [],
  inputId: "",
  outputId: "",
};
const listeners = new Set<() => void>();
function set(patch: Partial<VoiceSnapshot>) {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l());
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function getSnapshot(): VoiceSnapshot {
  return snap;
}
const SERVER_SNAPSHOT = snap;
export function getServerSnapshot(): VoiceSnapshot {
  return SERVER_SNAPSHOT;
}

/** Is the micActive threshold reached (mic on and above the noise floor)? */
export function micActive(s: VoiceSnapshot) {
  return s.micOn && s.micLevel > 0.12;
}

let room: LkRoom | null = null;
let attempt = 0; // bumped by every join / leave: an overtaken join gives up
let audioBox: HTMLDivElement | null = null;
let meterStop: (() => void) | null = null;
let loaded = false;

// ---- server state ----

export async function loadVoice(): Promise<void> {
  try {
    const r = await fetch("/api/voice", { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    loaded = true;
    set({
      enabled: !!d.enabled,
      admin: !!d.admin,
      maxSpeakers: typeof d.maxSpeakers === "number" ? d.maxSpeakers : 10,
      myUserId: d.userId ?? snap.myUserId,
      roomInfo: d.room ?? null,
      inputId: lsGet(LS_IN),
      outputId: lsGet(LS_OUT),
    });
  } catch {
    /* offline: try again on the next stream reconnect */
  }
}

/** Stream `voice` event (who is in the room). */
export function applyVoiceEvent(info: VoiceRoomInfo) {
  set({ roomInfo: info });
  if (room) refreshMembers();
}

export function voiceLoaded() {
  return loaded;
}

// ---- join / leave ----

export async function joinVoice(): Promise<void> {
  if (snap.phase !== "idle" || !snap.enabled) return;
  const mine = ++attempt;
  set({ phase: "connecting", notice: null });
  try {
    const r = await fetch("/api/voice/token", { method: "POST", cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (mine !== attempt) return;
    if (!r.ok) {
      set({ phase: "idle", notice: d?.code === "membership_ended" ? "BSM 会員資格が確認できません" : d?.error ?? "ボイスルームに入れません" });
      return;
    }
    set({ myUserId: d.identity });
    await connect(d.url, d.token, mine);
  } catch (e) {
    if (mine !== attempt) return;
    await teardown();
    set({ notice: "ボイスルームにつながりませんでした" });
    console.warn("[voice]", e);
  }
}

async function connect(url: string, token: string, mine: number) {
  const lk = await import("livekit-client");
  const r = new lk.Room({
    adaptiveStream: false,
    dynacast: false,
    audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  room = r;
  if (process.env.NODE_ENV !== "production") (window as unknown as { __bguruVoiceRoom?: LkRoom }).__bguruVoiceRoom = r;
  const changed = () => {
    if (room === r) refreshMembers();
  };
  r.on(lk.RoomEvent.TrackSubscribed, (track) => {
    if (track.kind !== lk.Track.Kind.Audio) return;
    const el = track.attach();
    ensureAudioBox().appendChild(el);
    if (snap.outputId) void (el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(snap.outputId).catch(() => {});
  })
    .on(lk.RoomEvent.TrackUnsubscribed, (track) => {
      track.detach().forEach((el) => el.remove());
    })
    .on(lk.RoomEvent.ParticipantConnected, () => {
      if (room !== r) return;
      applyRoomVolumes();
      refreshMembers();
    })
    .on(lk.RoomEvent.ParticipantDisconnected, changed)
    .on(lk.RoomEvent.ActiveSpeakersChanged, changed)
    .on(lk.RoomEvent.TrackMuted, (pub, participant) => {
      // An admin turned my mic off from the server: follow it.
      if (room === r && participant === r.localParticipant && pub.source === lk.Track.Source.Microphone && snap.micOn && !snap.micBusy) {
        stopMeter();
        set({ micOn: false, notice: "マイクがオフにされました（管理者の操作か、話せる人数の上限のため）" });
      }
      changed();
    })
    .on(lk.RoomEvent.TrackUnmuted, changed)
    .on(lk.RoomEvent.TrackPublished, changed)
    .on(lk.RoomEvent.TrackUnpublished, changed)
    .on(lk.RoomEvent.Reconnecting, () => room === r && set({ phase: "reconnecting" }))
    .on(lk.RoomEvent.Reconnected, () => {
      if (room !== r) return;
      set({ phase: "connected" });
      // Send the club-room permissions again after a reconnect, to be sure.
      sentAllowed = null;
      flushRoomPermissions();
    })
    .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => room === r && set({ needsAudioUnlock: !r.canPlaybackAudio }))
    .on(lk.RoomEvent.MediaDevicesChanged, () => room === r && void refreshDevices())
    .on(lk.RoomEvent.Disconnected, (reason) => {
      if (room !== r) return; // a late event from an earlier room
      const removed = reason === lk.DisconnectReason.PARTICIPANT_REMOVED;
      void teardown().then(() =>
        set({ notice: removed ? "ボイスルームから退出させられました" : reason === lk.DisconnectReason.CLIENT_INITIATED ? null : "ボイスルームの接続が切れました" })
      );
    });

  try {
    await r.connect(url, token);
  } catch {
    // One retry: right after a reload the server may still hold the previous
    // connection under the same identity and the first attempt can time out.
    if (mine !== attempt) return;
    await r.disconnect().catch(() => {});
    await r.connect(url, token);
  }
  if (mine !== attempt || room !== r) {
    await r.disconnect().catch(() => {});
    return;
  }
  // Club room: restrict who may receive my mic before it can ever be turned on.
  sentAllowed = null;
  flushRoomPermissions();
  applyRoomVolumes();
  // The join click is our user gesture; most browsers then allow playback.
  await r.startAudio().catch(() => {});
  set({ phase: "connected", micOn: false, needsAudioUnlock: !r.canPlaybackAudio });
  await refreshDevices();
  if (snap.outputId) await r.switchActiveDevice("audiooutput", snap.outputId).catch(() => {});
  refreshMembers();
}

export async function leaveVoice(): Promise<void> {
  await teardown();
}

async function teardown() {
  attempt++;
  const r = room;
  room = null;
  sentAllowed = null;
  if (permTimer != null) {
    clearTimeout(permTimer);
    permTimer = null;
  }
  stopMeter();
  set({ phase: "idle", micOn: false, micBusy: false, micLevel: 0, members: [], needsAudioUnlock: false });
  audioBox?.replaceChildren();
  await r?.disconnect().catch(() => {});
}

/** Unlock playback after the browser blocked it (needs a click). */
export async function unlockAudio() {
  await room?.startAudio().catch(() => {});
  set({ needsAudioUnlock: room ? !room.canPlaybackAudio : false });
}

// ---- mic ----

/** The first unmute starts the mic (and the browser may ask for permission),
 *  which takes a moment: flip at once and ignore taps until it finishes. */
export async function setMic(on: boolean): Promise<void> {
  const r = room;
  if (!r || (snap.phase !== "connected" && snap.phase !== "reconnecting") || snap.micBusy) return;
  // In the club room the server decides who may talk (POST /api/room voice) and the
  // track permissions decide who hears it; the old whole-room cap does not apply.
  if (on && proximity) flushRoomPermissions();
  else if (on && snap.members.filter((m) => !m.isMe && !m.muted).length >= snap.maxSpeakers) {
    set({ notice: `話せるのは同時に ${snap.maxSpeakers} 人までです。誰かがミュートするまでお待ちください` });
    return;
  }
  set({ micBusy: true, micOn: on, notice: null });
  try {
    // The saved mic is chosen here (not at join) so the browser asks for the
    // microphone only when the member actually unmutes.
    const lk = await import("livekit-client");
    // Speech-quality Opus, nothing sent during silence (DTX), no redundant copy
    // (RED doubles the bytes): ~3x less upstream than the defaults for 100 listeners.
    await r.localParticipant.setMicrophoneEnabled(on, on && snap.inputId ? { deviceId: snap.inputId } : undefined, {
      audioPreset: lk.AudioPresets.speech,
      dtx: true,
      red: false,
    });
    if (on) {
      startMeter(r);
      void refreshDevices(); // names become readable once the mic is allowed
    } else stopMeter();
  } catch {
    set({ micOn: r.localParticipant.isMicrophoneEnabled, notice: on ? "マイクを使えません（ブラウザでマイクを許可してください）" : null });
  } finally {
    if (room === r) set({ micBusy: false });
    refreshMembers();
  }
}

function startMeter(r: LkRoom) {
  stopMeter();
  void import("livekit-client").then((lk) => {
    if (room !== r) return;
    const pub = r.localParticipant.getTrackPublication(lk.Track.Source.Microphone);
    const track = pub?.track as LocalAudioTrack | undefined;
    if (!track) return;
    // Use the analyser's waveform (not calculateVolume, whose byte-frequency
    // value is already dB-scaled and reads "loud" for room noise) and measure
    // RMS → dBFS exactly like the native apps (-50 dBFS → 0, -10 dBFS → 1).
    const { analyser, cleanup } = lk.createAudioAnalyser(track, { cloneTrack: true });
    const buf = new Float32Array(analyser.fftSize);
    let level = 0;
    const timer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const db = 20 * Math.log10(Math.max(rms, 1e-6));
      const target = Math.min(Math.max((db + 50) / 40, 0), 1);
      level = target > level ? target : Math.max(target, level * 0.7);
      if (Math.abs(level - snap.micLevel) > 0.02) {
        const wasActive = micActive(snap);
        set({ micLevel: level });
        if (wasActive !== micActive(snap)) refreshMembers();
      }
    }, 66);
    meterStop = () => {
      window.clearInterval(timer);
      void cleanup();
    };
  });
}

function stopMeter() {
  meterStop?.();
  meterStop = null;
  if (snap.micLevel !== 0) set({ micLevel: 0 });
}

// ---- moderation ----

export async function kickVoice(userId: string, ban = false): Promise<void> {
  try {
    const r = await fetch("/api/voice/kick", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, ban }),
    });
    const d = await r.json().catch(() => ({}));
    set({ notice: r.ok ? (ban ? "退出させ、入室禁止にしました" : "退出させました") : d?.error ?? "操作できませんでした" });
  } catch {
    set({ notice: "操作できませんでした" });
  }
}

export async function reportVoice(userId: string, reason: string): Promise<boolean> {
  try {
    const r = await fetch("/api/voice/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, reason }),
    });
    const d = await r.json().catch(() => ({}));
    set({ notice: r.ok ? "管理者に通報しました" : d?.error ?? "通報できませんでした" });
    return r.ok;
  } catch {
    set({ notice: "通報できませんでした" });
    return false;
  }
}

export interface VoiceBanRow {
  userId: string | null;
  name: string | null;
  reason: string | null;
  bannedAt: string;
}

export async function fetchVoiceBans(): Promise<VoiceBanRow[]> {
  const r = await fetch("/api/voice/bans", { cache: "no-store" });
  if (!r.ok) return [];
  const d = await r.json().catch(() => ({}));
  return (d?.bans ?? []) as VoiceBanRow[];
}

export async function unbanVoice(userId: string): Promise<boolean> {
  const r = await fetch("/api/voice/bans", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId }),
  }).catch(() => null);
  return !!r?.ok;
}

/** Only admins remove / mute / ban (the server enforces the same). */
export function canModerate(s: VoiceSnapshot): boolean {
  return s.admin;
}

export async function muteVoice(userId: string): Promise<void> {
  try {
    const r = await fetch("/api/voice/mute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    });
    const d = await r.json().catch(() => ({}));
    set({ notice: r.ok ? (d?.muted ? "ミュートしました" : "マイクはオフでした") : d?.error ?? "操作できませんでした" });
  } catch {
    set({ notice: "操作できませんでした" });
  }
}

// ---- devices ----

async function refreshDevices() {
  const lk = await import("livekit-client");
  const def: DeviceChoice = { id: "", name: "ブラウザの設定に従う" };
  const name = (d: MediaDeviceInfo, i: number) => d.label || `デバイス ${i + 1}`;
  try {
    // requestPermissions=false: listing must not trigger the mic prompt.
    const ins = (await lk.Room.getLocalDevices("audioinput", false)).filter((d) => d.deviceId !== "default");
    const outs = lk.supportsAudioOutputSelection()
      ? (await lk.Room.getLocalDevices("audiooutput", false)).filter((d) => d.deviceId !== "default")
      : [];
    set({
      inputs: [def, ...ins.map((d, i) => ({ id: d.deviceId, name: name(d, i) }))],
      outputs: outs.length ? [def, ...outs.map((d, i) => ({ id: d.deviceId, name: name(d, i) }))] : [],
    });
  } catch {
    /* no device access yet */
  }
}

export async function selectInput(id: string) {
  lsSet(LS_IN, id);
  set({ inputId: id });
  // Muted: remembered and used on the next unmute (no mic prompt now).
  if (!snap.micOn) return;
  await room?.switchActiveDevice("audioinput", id || "default").catch(() => set({ notice: "そのマイクに切り替えられませんでした" }));
}

export async function selectOutput(id: string) {
  lsSet(LS_OUT, id);
  set({ outputId: id });
  await room?.switchActiveDevice("audiooutput", id || "default").catch(() => set({ notice: "そのスピーカーに切り替えられませんでした" }));
}

// ---- members ----

function refreshMembers() {
  const r = room;
  if (!r) {
    set({ members: [] });
    return;
  }
  const known = new Map((snap.roomInfo?.participants ?? []).map((p) => [p.user_id, p]));
  const toMember = (p: Participant, isMe: boolean): VoiceMember | null => {
    const id = p.identity;
    if (!id) return null;
    const info = known.get(id);
    return {
      userId: id,
      name: p.name || info?.name || "?",
      avatar: info?.avatar ?? null,
      // My own talking shows on the mic button, not as a ring on my face.
      speaking: !isMe && p.isSpeaking,
      muted: !p.isMicrophoneEnabled,
      isMe,
    };
  };
  const me = toMember(r.localParticipant, true);
  const others = Array.from(r.remoteParticipants.values())
    .map((p) => toMember(p, false))
    .filter((m): m is VoiceMember => !!m)
    // Talking first, then mics on, then listeners — the bar only shows the first few.
    .sort((a, b) =>
      a.speaking !== b.speaking ? (a.speaking ? -1 : 1) : a.muted !== b.muted ? (a.muted ? 1 : -1) : a.name.localeCompare(b.name, "ja")
    );
  set({ members: me ? [me, ...others] : others });
}

function ensureAudioBox(): HTMLDivElement {
  if (!audioBox) {
    audioBox = document.createElement("div");
    audioBox.style.display = "none";
    audioBox.setAttribute("aria-hidden", "true");
    document.body.appendChild(audioBox);
  }
  return audioBox;
}

// ---- club room (ルーム): proximity voice ----
//
// While the room view is on, the room client hands us, on every room change,
// the volume for each LiveKit identity (= user id) and the sorted list of people
// allowed to receive my microphone. Volumes apply at once; the permission set is
// sent only when it changes, batched (~300 ms), and right after connecting.
// null = not in the room view (the old voice bar behaviour, nothing restricted).

export interface RoomProximity {
  volumes: Map<string, number>;
  /** Sorted identities allowed to subscribe to my mic. */
  allowed: string[];
}

const PERM_BATCH_MS = 300;
let proximity: RoomProximity | null = null;
let sentAllowed: string[] | null = null;
let permTimer: ReturnType<typeof setTimeout> | null = null;

export function setRoomProximity(p: RoomProximity | null): void {
  proximity = p;
  if (!p) {
    if (permTimer != null) clearTimeout(permTimer);
    permTimer = null;
    return;
  }
  applyRoomVolumes();
  if (!room || sameIds(p.allowed, sentAllowed) || permTimer != null) return;
  permTimer = setTimeout(() => {
    permTimer = null;
    flushRoomPermissions();
  }, PERM_BATCH_MS);
}

function applyRoomVolumes(): void {
  const r = room;
  const p = proximity;
  if (!r || !p) return;
  for (const rp of r.remoteParticipants.values()) {
    try {
      rp.setVolume(p.volumes.get(rp.identity) ?? 0);
    } catch {
      /* participant going away */
    }
  }
}

function flushRoomPermissions(): void {
  const r = room;
  const p = proximity;
  if (!r || !p) return;
  if (permTimer != null) {
    clearTimeout(permTimer);
    permTimer = null;
  }
  if (sameIds(p.allowed, sentAllowed)) return;
  try {
    r.localParticipant.setTrackSubscriptionPermissions(
      false,
      p.allowed.map((id) => ({ participantIdentity: id, allowAll: true }))
    );
    sentAllowed = [...p.allowed];
  } catch (e) {
    console.warn("[voice] track permissions", e);
  }
}

/** The mic / leave buttons outside the room view (VoiceMini) go through the room
 *  client while it is active, so the server's mic state stays in step. */
export interface VoiceHooks {
  mic: (on: boolean) => Promise<void>;
  leave: () => Promise<void>;
}
let hooks: VoiceHooks | null = null;
export function setVoiceHooks(h: VoiceHooks | null): void {
  hooks = h;
}
export function userSetMic(on: boolean): Promise<void> {
  return hooks ? hooks.mic(on) : setMic(on);
}
export function userLeaveVoice(): Promise<void> {
  return hooks ? hooks.leave() : leaveVoice();
}

/** Show a line in the voice notice (room errors such as the speaker limit). */
export function setVoiceNotice(notice: string | null): void {
  set({ notice });
}
