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
  /** 相手ごとの音量（自分だけ、0…1、無ければ 1）。ブラウザに覚える（2026-11-08 オフ会「ブラウザで音量を変えたい」）。 */
  gains: Record<string, number>;
  /** 出入りの効果音（既定はオン）。 */
  sfx: boolean;
  inputId: string;
  outputId: string;
}

const LS_IN = "bguru-voice-input";
const LS_GAINS = "bguru-voice-gains";
const LS_SFX = "bguru-voice-sfx";
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
  gains: {},
  sfx: true,
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

/** 音声の様子をサーバのログへ（/api/voice/diag、2026-11-08 ブラウザで聞こえない件の調査）。失敗しても何もしない。 */
export function voiceDiag(event: string, extra: Record<string, unknown> = {}): void {
  try {
    const r = room;
    const remotes = r ? [...r.remoteParticipants.values()] : [];
    const audio = remotes.filter((p) => [...p.audioTrackPublications.values()].some((t) => t.isSubscribed && t.track));
    const published = remotes.filter((p) => p.audioTrackPublications.size > 0).length;
    const body = {
      event,
      phase: snap.phase,
      state: r?.state ?? null,
      remotes: remotes.length,
      published,
      subscribed: audio.length,
      audible: proximity ? audio.filter((p) => (proximity!.volumes.get(p.identity) ?? 0) > 0).length : null,
      playback: r ? r.canPlaybackAudio : null,
      mic: snap.micOn,
      room: !!proximity,
      ...extra,
    };
    void fetch("/api/voice/diag", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
  } catch {
    /* never break the voice for this */
  }
}
let diagTimer: ReturnType<typeof setInterval> | null = null;
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
      gains: readGains(),
      sfx: lsGet(LS_SFX) !== "0",
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
  if (snap.phase !== "idle") return;
  const before = ++attempt; // 読み直しの間に「見るだけ」などで抜けたら、ここで止まる（qa-engineer 2026-11-08）
  // 「使えるか」をまだ読めていない（再起動中の 502 などで失敗したまま）なら、ここで読み直す。
  // 読めないまま入ろうとすると一瞬で失敗して「見るだけにしました」に戻されていた（2026-11-08 オフ会の報告）
  if (!loaded || !snap.enabled) {
    await loadVoice();
    if (!loaded) {
      await new Promise((r) => setTimeout(r, 1500));
      await loadVoice();
    }
    voiceDiag("join_after_load", { loaded, enabled: snap.enabled });
    if (before !== attempt || !snap.enabled || snap.phase !== "idle") return;
  }
  if (before !== attempt) return;
  const mine = ++attempt;
  movedAway = false;
  removedLast = false;
  set({ phase: "connecting", notice: null });
  try {
    const r = await fetch("/api/voice/token", { method: "POST", cache: "no-store" });
    const d = await r.json().catch(() => ({}));
    if (mine !== attempt) return;
    if (!r.ok) {
      voiceDiag("token_failed", { status: r.status, code: d?.code ?? null });
      set({ phase: "idle", notice: d?.code === "membership_ended" ? "BSM 会員資格が確認できません" : d?.error ?? "ボイスルームに入れません" });
      return;
    }
    set({ myUserId: d.identity });
    await connect(d.url, d.token, mine);
  } catch (e) {
    if (mine !== attempt) return;
    // 接続先の URL は残さない
    voiceDiag("connect_failed", { error: String((e as Error)?.message ?? e).replace(/wss?:\/\/\S+/g, "<url>").slice(0, 160) });
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
    .on(lk.RoomEvent.ParticipantConnected, (p) => {
      if (room !== r) return;
      applyRoomVolumes();
      refreshMembers();
      if (snap.phase === "connected" && audibleToMe(p.identity)) playVoiceSfx("in");
    })
    .on(lk.RoomEvent.ParticipantDisconnected, (p) => {
      if (room !== r) return;
      changed();
      if (audibleToMe(p.identity)) playVoiceSfx("out");
    })
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
    .on(lk.RoomEvent.Reconnecting, () => {
      if (room !== r) return;
      set({ phase: "reconnecting" });
      voiceDiag("reconnecting");
    })
    .on(lk.RoomEvent.Reconnected, () => {
      if (room !== r) return;
      set({ phase: "connected" });
      // Send the club-room permissions again after a reconnect, to be sure.
      sentAllowed = null;
      flushRoomPermissions();
    })
    .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => {
      if (room !== r) return;
      set({ needsAudioUnlock: !r.canPlaybackAudio });
      voiceDiag("playback_changed");
    })
    .on(lk.RoomEvent.MediaDevicesChanged, () => room === r && void refreshDevices())
    .on(lk.RoomEvent.Disconnected, (reason) => {
      if (room !== r) return; // a late event from an earlier room
      voiceDiag("disconnected", { reason: reason ?? null });
      const removed = reason === lk.DisconnectReason.PARTICIPANT_REMOVED;
      // 同じ人が別の端末で入った（スマホで続けた）: 失敗ではない。
      const moved = reason === lk.DisconnectReason.DUPLICATE_IDENTITY;
      removedLast = removed;
      movedAway = moved; // 部室（room-client）がサーバへ「聞いていない」と書かないように（書くと続けた端末のマイクまで切れる）
      void teardown().then(() =>
        set({
          notice: moved
            ? HANDOFF_MOVED
            : removed
              ? "ボイスルームから退出させられました"
              : reason === lk.DisconnectReason.CLIENT_INITIATED
                ? null
                : "ボイスルームの接続が切れました",
        })
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
  voiceDiag("connected");
  playVoiceSfx("in", true);
  // つながっている間は 60 秒ごとに様子を送る（聞こえる相手が 0 のまま、などを見る）
  if (diagTimer) clearInterval(diagTimer);
  diagTimer = setInterval(() => (room ? voiceDiag("tick") : diagTimer && clearInterval(diagTimer)), 60_000);
  await refreshDevices();
  if (snap.outputId) await r.switchActiveDevice("audiooutput", snap.outputId).catch(() => {});
  refreshMembers();
}

let movedAway = false;
let removedLast = false;
/** 最後の切断が管理者の「退出させる」だったか（部室はこのとき自動で入り直さない）。 */
export function voiceWasRemoved(): boolean {
  return removedLast;
}
/** 最後の切断が「別の端末で続けた」だったか（次に入るまで）。 */
export function voiceMovedAway(): boolean {
  return movedAway;
}

/** 音声が別の端末に移ったときの文（🍻 も同じ）。 */
export const HANDOFF_MOVED = "別の端末で続けています";

/** 「スマホで続ける」: 本人のスマホへ知らせを送る（docs/device-sync-spec.md）。音声はスマホが入るまで続ける。
 *  返り値は出す文。 */
export async function requestHandoff(target: "offkai" | "voice" | "room", mic: boolean): Promise<string> {
  try {
    const r = await fetch("/api/voice/handoff", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target, mic }),
    });
    const d = (await r.json().catch(() => null)) as { sent?: number; error?: string } | null;
    if (!r.ok) return d?.error ?? "送れませんでした";
    return (d?.sent ?? 0) > 0
      ? "スマホの知らせをタップすると、そちらに切り替わります"
      : "続けられるスマホが見つかりません（アプリを最新にしてください）";
  } catch {
    return "送れませんでした";
  }
}

/** ボイスルーム・部室の音声をスマホで続ける。 */
export async function handoffVoice(): Promise<void> {
  if (!room) return;
  set({ notice: await requestHandoff(proximity ? "room" : "voice", snap.micOn) });
}

export async function leaveVoice(why = "leave"): Promise<void> {
  if (room) {
    voiceDiag("leave", { why });
    if (snap.phase === "connected") playVoiceSfx("out", true);
  }
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
  if (!r) return;
  for (const rp of r.remoteParticipants.values()) {
    try {
      // 部室は距離の音量 × 自分で決めた音量。ボイスルーム（部室でない）は自分で決めた音量だけ
      const near = p ? (p.volumes.get(rp.identity) ?? 0) : 1;
      rp.setVolume(near * gainOf(rp.identity));
    } catch {
      /* participant going away */
    }
  }
}

// ---- 相手ごとの音量（自分だけ） ----

function readGains(): Record<string, number> {
  try {
    const o = JSON.parse(lsGet(LS_GAINS) || "{}") as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) if (typeof v === "number" && v >= 0 && v <= 1) out[k] = v;
    return out;
  } catch {
    return {};
  }
}
function gainOf(id: string): number {
  return snap.gains[id] ?? 1;
}
/** 相手の声の大きさ（0…1）。1 は覚えない（いつもの大きさ）。 */
export function setUserGain(id: string, gain: number): void {
  const g = Math.max(0, Math.min(1, Math.round(gain * 100) / 100));
  const gains = { ...snap.gains };
  if (g >= 1) delete gains[id];
  else gains[id] = g;
  set({ gains });
  lsSet(LS_GAINS, JSON.stringify(gains));
  applyRoomVolumes();
}

/** 自分で決めた音量を全部もとに戻す。 */
export function resetUserGains(): void {
  set({ gains: {} });
  lsSet(LS_GAINS, "{}");
  applyRoomVolumes();
}

// ---- 出入りの効果音（その場で作る短い音。音の素材は使わない） ----

export function setVoiceSfx(on: boolean): void {
  set({ sfx: on });
  lsSet(LS_SFX, on ? "1" : "0");
}
let sfxCtx: AudioContext | null = null;
let sfxLast = 0;
/** in: 上がる 2 音、out: 下がる 2 音。自分の出入りは少し大きく。1.2 秒に 1 回まで（大勢の出入りで鳴りっぱなしにしない）。 */
export function playVoiceSfx(kind: "in" | "out", mine = false): void {
  if (!snap.sfx || typeof window === "undefined") return;
  const now = Date.now();
  if (!mine && now - sfxLast < 1200) return;
  sfxLast = now;
  try {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    sfxCtx ??= new AC();
    const ctx = sfxCtx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const notes = kind === "in" ? [660, 990] : [740, 494];
    const peak = mine ? 0.12 : 0.06;
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.09;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t);
      o.stop(t + 0.18);
    });
  } catch {
    /* no audio: fine */
  }
}
/** その人の出入りを鳴らすか: 部室では声が届く範囲の人だけ、ボイスルームでは全員。 */
function audibleToMe(id: string): boolean {
  return proximity ? (proximity.volumes.get(id) ?? 0) > 0 : true;
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
