"use client";
/* 🍻 オフ会の Web クライアントの状態（React の外。watch-client.ts と同じ形で useSyncExternalStore から読む）。
 *
 *   loadOffkai()        GET /api/offkai — 200 = 使える、404 = 出していない（「🍻」を出さない）
 *   applyOffkaiEvent()  /api/posts/stream の `event: offkai`（始まり・変化・終わり・写真・聞いている人数）
 *   listen / speak      LiveKit の部屋 bguru-offkai-<id>（聞くだけ／話す人だけ話せる鍵。後勝ち）
 *   uploadPhotos()      端末で 1280px・EXIF なしにしてから POST /api/offkai/photos（multipart）
 * 聞いている間はボイスルームから抜ける（2 つの部屋の音を同時に出さない）。仕様: docs/offkai-spec.md */
import type { Room as LkRoom } from "livekit-client";
import type { EventDto, PhotoDto } from "./offkai";
import { prepareChatPhoto } from "./chat-photos";
import { getSnapshot as getVoiceSnapshot, userLeaveVoice } from "./voice-client";

export type OffkaiAvailability = "unknown" | "enabled" | "disabled";
export type AudioPhase = "idle" | "connecting" | "listening" | "speaking";

export interface OffkaiSnapshot {
  status: OffkaiAvailability;
  open: boolean;
  current: EventDto | null;
  listeners: number;
  archive: EventDto[];
  archiveMore: boolean;
  /** 開いているアルバム（開催中の会か、アーカイブから開いた会）。 */
  album: { event: EventDto; photos: PhotoDto[]; more: number | null } | null;
  audio: AudioPhase;
  needsAudioUnlock: boolean;
  myUserId: string | null;
  busy: boolean;
  error: { message: string; at: number } | null;
}

let snap: OffkaiSnapshot = {
  status: "unknown",
  open: false,
  current: null,
  listeners: 0,
  archive: [],
  archiveMore: false,
  album: null,
  audio: "idle",
  needsAudioUnlock: false,
  myUserId: null,
  busy: false,
  error: null,
};
const SERVER_SNAPSHOT = snap;
const subs = new Set<() => void>();

function set(patch: Partial<OffkaiSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of subs) l();
}
export function subscribe(l: () => void): () => void {
  subs.add(l);
  return () => subs.delete(l);
}
export const getSnapshot = (): OffkaiSnapshot => snap;
export const getServerSnapshot = (): OffkaiSnapshot => SERVER_SNAPSHOT;

type Body = Record<string, unknown> & { error?: string; code?: string };

async function api(path: string, init?: RequestInit & { json?: unknown }): Promise<{ status: number; body: Body | null }> {
  const { json, ...rest } = init ?? {};
  const r = await fetch(`/api/offkai${path}`, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json" } } : {}),
  });
  let body: Body | null = null;
  try {
    body = (await r.json()) as Body;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

let errorTimer: ReturnType<typeof setTimeout> | null = null;
/** 断られた理由を 8 秒だけ出す。 */
function showError(message: string): void {
  set({ error: { message, at: Date.now() } });
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => set({ error: null }), 8000);
}

function fail(r: { status: number; body: Body | null }, fallback: string): void {
  showError(r.body?.error ?? `${fallback}（${r.status}）`);
}

/** 新しい版だけ受け取る（遅れて届いた応答で戻さない）。can_end は GET の値を残す（知らせの event は false）。 */
function takeCurrent(e: EventDto | null | undefined, fromGet = false): void {
  if (e === undefined) return;
  const cur = snap.current;
  if (e && cur && e.id === cur.id && e.version < cur.version) return;
  const next = e && cur && e.id === cur.id && !fromGet ? { ...e, can_end: canEnd(e) || cur.can_end } : e ? (fromGet ? e : { ...e, can_end: canEnd(e) }) : null;
  const ended = cur && (!next || next.id !== cur.id || next.ended_at);
  set({ current: next && !next.ended_at ? next : null });
  if (snap.album && next && snap.album.event.id === next.id) set({ album: { ...snap.album, event: next } });
  // 話す人が自分でなくなった（後勝ち）: すぐマイクを止める。終わったら部屋から出る。
  if (ended) void stopAudio();
  else if (snap.audio === "speaking" && next && next.speaker?.user_id !== snap.myUserId) void demote();
}

function canEnd(e: EventDto): boolean {
  const me = snap.myUserId;
  return !!me && !e.ended_at && (e.started_by.user_id === me || e.speaker?.user_id === me);
}

let loading: Promise<void> | null = null;
export function loadOffkai(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await api("");
      if (r.status === 404 || r.status === 401) {
        set({ status: "disabled" });
        return;
      }
      if (r.status !== 200 || !r.body) return;
      const b = r.body as unknown as { current: EventDto | null; listeners: number; archive: EventDto[] };
      set({ status: "enabled", listeners: b.listeners ?? 0, archive: b.archive ?? [], archiveMore: (b.archive?.length ?? 0) >= 20 });
      takeCurrent(b.current, true);
      if (snap.current && (!snap.album || snap.album.event.id === snap.current.id)) void openAlbum(snap.current);
    } catch {
      /* offline: keep what we have */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function reloadOffkai(): void {
  if (snap.status === "enabled") void loadOffkai();
}

export async function loadMoreArchive(): Promise<void> {
  const last = snap.archive[snap.archive.length - 1];
  if (!last) return;
  const r = await api(`?before=${last.id}`);
  const more = (r.body as unknown as { archive?: EventDto[] } | null)?.archive ?? [];
  set({ archive: [...snap.archive, ...more.filter((e) => !snap.archive.some((x) => x.id === e.id))], archiveMore: more.length >= 20 });
}

export function applyOffkaiEvent(data: unknown): void {
  if (snap.status === "disabled") return;
  const d = data as { action?: string; event?: EventDto; event_id?: number; eventId?: number; photo?: PhotoDto; photo_id?: number; photoId?: number; listeners?: number } | null;
  if (!d?.action) return;
  if (snap.status === "unknown") set({ status: "enabled" });
  const eventId = d.event_id ?? d.eventId;
  switch (d.action) {
    case "listeners":
      set({ listeners: d.listeners ?? 0 });
      return;
    case "start":
      takeCurrent(d.event);
      if (d.event) void openAlbum(d.event);
      return;
    case "update":
      takeCurrent(d.event);
      return;
    case "end":
      takeCurrent(d.event);
      if (d.event) set({ archive: [d.event, ...snap.archive.filter((e) => e.id !== d.event!.id)] });
      return;
    case "photo":
      if (d.photo && snap.album && snap.album.event.id === eventId && !snap.album.photos.some((p) => p.id === d.photo!.id)) {
        const mine = !!snap.myUserId && d.photo.uploader.user_id === snap.myUserId;
        set({ album: { ...snap.album, photos: [...snap.album.photos, { ...d.photo, mine }] } });
      }
      return;
    case "photo_delete": {
      const pid = d.photo_id ?? d.photoId;
      if (snap.album && snap.album.event.id === eventId) set({ album: { ...snap.album, photos: snap.album.photos.filter((p) => p.id !== pid) } });
      return;
    }
  }
}

export function setOffkaiOpen(open: boolean): void {
  set({ open });
  if (open) void loadOffkai();
}

export function setMyUserId(id: string | null): void {
  if (id !== snap.myUserId) set({ myUserId: id });
}

// ---- 始める・終える ----

export async function startOffkai(title: string): Promise<boolean> {
  set({ busy: true });
  try {
    const r = await api("", { method: "POST", json: { title } });
    if (r.status === 201) {
      const e = (r.body as unknown as { event: EventDto }).event;
      takeCurrent(e, true);
      void openAlbum(e);
      return true;
    }
    if (r.status === 409 && r.body?.current) takeCurrent(r.body.current as EventDto, true);
    fail(r, "始められませんでした");
  } catch {
    showError("通信できませんでした");
  } finally {
    set({ busy: false });
  }
  return false;
}

export async function endOffkai(): Promise<void> {
  const r = await api("/end", { method: "POST" });
  if (r.status === 200) {
    const e = (r.body as unknown as { event: EventDto }).event;
    takeCurrent(e, true);
    set({ archive: [e, ...snap.archive.filter((x) => x.id !== e.id)] });
  } else fail(r, "終了できませんでした");
}

// ---- アルバム ----

export async function openAlbum(event: EventDto): Promise<void> {
  set({ album: { event, photos: snap.album?.event.id === event.id ? snap.album.photos : [], more: null } });
  const r = await api(`/${event.id}/photos?limit=200`);
  if (r.status !== 200 || snap.album?.event.id !== event.id) return;
  const b = r.body as unknown as { photos: PhotoDto[]; next_after: number | null };
  set({ album: { event: snap.album.event, photos: b.photos, more: b.next_after } });
}

export async function loadMorePhotos(): Promise<void> {
  const a = snap.album;
  if (!a || a.more == null) return;
  const r = await api(`/${a.event.id}/photos?after=${a.more}&limit=200`);
  if (r.status !== 200 || snap.album?.event.id !== a.event.id) return;
  const b = r.body as unknown as { photos: PhotoDto[]; next_after: number | null };
  set({ album: { ...snap.album, photos: [...snap.album.photos, ...b.photos.filter((p) => !snap.album!.photos.some((x) => x.id === p.id))], more: b.next_after } });
}

export function closeAlbum(): void {
  set({ album: snap.current ? { event: snap.current, photos: snap.album?.event.id === snap.current.id ? snap.album.photos : [], more: null } : null });
  if (snap.current && snap.album?.photos.length === 0) void openAlbum(snap.current);
}

export async function uploadPhotos(files: File[], caption: string): Promise<boolean> {
  const imgs = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name)).slice(0, 4);
  if (imgs.length === 0) return false;
  set({ busy: true });
  try {
    const blobs = await Promise.all(imgs.map((f) => prepareChatPhoto(f)));
    const form = new FormData();
    blobs.forEach((b, i) => form.append("images", b, `photo-${i + 1}.${b.type === "image/gif" ? "gif" : "jpg"}`));
    form.append("caption", caption);
    const r = await fetch("/api/offkai/photos", { method: "POST", body: form, cache: "no-store" });
    const d = (await r.json().catch(() => null)) as Body | null;
    if (r.status === 201) {
      const photos = (d as unknown as { photos: PhotoDto[] }).photos;
      if (snap.album && snap.current && snap.album.event.id === snap.current.id) {
        set({ album: { ...snap.album, photos: [...snap.album.photos, ...photos.filter((p) => !snap.album!.photos.some((x) => x.id === p.id))] } });
      }
      return true;
    }
    fail({ status: r.status, body: d }, "写真を送れませんでした");
  } catch {
    showError("写真を送れませんでした");
  } finally {
    set({ busy: false });
  }
  return false;
}

export async function deletePhoto(id: number): Promise<void> {
  const r = await api(`/photos/${id}`, { method: "DELETE" });
  if (r.status !== 200) return fail(r, "消せませんでした");
  if (snap.album) set({ album: { ...snap.album, photos: snap.album.photos.filter((p) => p.id !== id) } });
}

// ---- 声（LiveKit） ----

let room: LkRoom | null = null;
let attempt = 0;
let audioBox: HTMLDivElement | null = null;

function ensureAudioBox(): HTMLDivElement {
  if (!audioBox) {
    audioBox = document.createElement("div");
    audioBox.style.display = "none";
    audioBox.dataset.cx = "offkai-audio";
    document.body.appendChild(audioBox);
  }
  return audioBox;
}

/** 聞く（聞くだけの鍵）。ボイスルームにいれば抜ける。 */
export async function listen(): Promise<void> {
  if (snap.audio !== "idle" || !snap.current) return;
  const r = await api("/token", { method: "POST" });
  if (r.status !== 200 || !r.body) return fail(r, "つながりませんでした");
  await connectWith(r.body as unknown as Tok, false);
}

/** 現地から話す（後勝ち）。話せる鍵で入り直してマイクを出す。 */
export async function speak(): Promise<void> {
  if (!snap.current) return;
  set({ busy: true });
  try {
    const r = await api("/speak", { method: "POST", json: { on: true } });
    if (r.status !== 200 || !r.body) return fail(r, "話せませんでした");
    takeCurrent((r.body as unknown as { event: EventDto }).event, true);
    if (!r.body.token) return fail({ status: 503, body: { error: "音声は今使えません" } }, "話せませんでした");
    await connectWith(r.body as unknown as Tok, true);
  } finally {
    set({ busy: false });
  }
}

/** 話すのをやめる（聞くのは続ける）。 */
export async function stopSpeaking(): Promise<void> {
  const r = await api("/speak", { method: "POST", json: { on: false } });
  if (r.status === 200) takeCurrent((r.body as unknown as { event: EventDto }).event, true);
  await demote();
}

/** マイクを止めて聞くだけに戻る（後勝ちで替わられたときも）。 */
async function demote(): Promise<void> {
  if (snap.audio !== "speaking") return;
  await room?.localParticipant.setMicrophoneEnabled(false).catch(() => {});
  set({ audio: room ? "listening" : "idle" });
}

export async function stopAudio(): Promise<void> {
  attempt++;
  const r = room;
  room = null;
  audioBox?.replaceChildren();
  set({ audio: "idle", needsAudioUnlock: false });
  await r?.disconnect().catch(() => {});
}

export async function unlockOffkaiAudio(): Promise<void> {
  await room?.startAudio().catch(() => {});
  set({ needsAudioUnlock: room ? !room.canPlaybackAudio : false });
}

type Tok = { token: string; url: string; room: string; can_speak: boolean };

async function connectWith(t: Tok, publish: boolean): Promise<void> {
  // 同時に 2 つの部屋の音は出さない。
  if (getVoiceSnapshot().phase !== "idle") await userLeaveVoice().catch(() => {});
  await stopAudio();
  const mine = ++attempt;
  set({ audio: "connecting" });
  try {
    const lk = await import("livekit-client");
    const r = new lk.Room({
      adaptiveStream: false,
      dynacast: false,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    room = r;
    r.on(lk.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === lk.Track.Kind.Audio) ensureAudioBox().appendChild(track.attach());
    })
      .on(lk.RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()))
      .on(lk.RoomEvent.AudioPlaybackStatusChanged, () => room === r && set({ needsAudioUnlock: !r.canPlaybackAudio }))
      .on(lk.RoomEvent.ParticipantPermissionsChanged, () => {
        // 後勝ちで話す権利を取り上げられた
        if (room === r && snap.audio === "speaking" && !r.localParticipant.permissions?.canPublish) void demote();
      })
      .on(lk.RoomEvent.Disconnected, () => {
        if (room !== r) return;
        room = null;
        audioBox?.replaceChildren();
        set({ audio: "idle" });
      });
    await r.connect(t.url, t.token);
    if (mine !== attempt || room !== r) {
      await r.disconnect().catch(() => {});
      return;
    }
    await r.startAudio().catch(() => {});
    if (publish && t.can_speak) {
      await r.localParticipant.setMicrophoneEnabled(true);
      set({ audio: "speaking", needsAudioUnlock: !r.canPlaybackAudio });
    } else {
      set({ audio: "listening", needsAudioUnlock: !r.canPlaybackAudio });
    }
  } catch (e) {
    if (mine !== attempt) return;
    await stopAudio();
    showError("音声につながりませんでした");
    console.warn("[offkai]", e);
  }
}
