"use client";
/* 👥 グループ DM の Web クライアントの状態（dm-client.ts と同じ形、docs/group-dm-spec.md）。
 *
 *   loadGdm()          GET /api/gdm — 200 = 使える、404 = 出していない（グループの部品を出さない）
 *   openGroup(id)      1 つのグループを開く（DM の引き出しの中。1 対 1 の会話とは同時に開かない）
 *   sendGroupText()    楽観的に出して POST、client_id で突き合わせる
 *   applyGdmEvent()    /api/posts/stream の `event: gdm`
 * 発言は 30 日で消える: 期限を過ぎたものはここでも隠す。 */
import { newChatClientId } from "./chat-optimistic";
import { toggleReactionOptimistic, type OptimisticReaction } from "./reaction-optimistic";
import {
  dropDmPhotoJob,
  dropUnsentPhotoJobs,
  permanentUploadFailure,
  photoUploadError,
  setDmPhotoJob,
  takeDmPhotoJob,
  uploadDmPhotoJob,
  type PickedPhoto,
} from "./dm-photos-client";
import { DM_TTL_MS } from "./dm-client";

export type GMember = { user_id: string; name: string | null; avatar: string | null; is_creator: boolean; is_me: boolean };
export type Group = {
  id: number;
  name: string | null;
  title: string;
  photo?: string | null;
  members: GMember[];
  member_count: number;
  is_creator: boolean;
  muted: boolean;
  /** 🐶 @ビーグル に答えるか（古いサーバには無い）。 */
  beagle?: boolean;
  created_at: string;
};
export type GMessage = {
  id: number;
  group_id: number;
  kind: "text" | "system";
  from_id: string | null;
  from_name: string | null;
  from_avatar: string | null;
  body: string;
  /** 付けた写真（/api/media/dm-…。送信中はプレビューの blob: URL）。 */
  images?: string[];
  created_at: string;
  is_author: boolean;
  /** 🐶 ビーグルの答え。 */
  is_beagle?: boolean;
  /** 送った本人が直した（「編集済み」）。古いサーバには無い。 */
  edited?: boolean;
  edited_at?: string | null;
  /** リアクション（チャットと同じ形）。古いサーバ・一覧の last_message には無い／空。 */
  reactions?: OptimisticReaction[];
  client_id?: string;
  pending?: boolean;
  failed?: boolean;
};
export type GroupSummary = { group: Group; last_message: GMessage | null; unread_count: number };

export interface GdmSnapshot {
  status: "unknown" | "enabled" | "disabled";
  unread: number;
  groups: GroupSummary[];
  /** 開いているグループ（null なら開いていない）。 */
  current: Group | null;
  messages: GMessage[];
  canSend: boolean;
  loading: boolean;
  error: string | null;
}

const INITIAL: GdmSnapshot = { status: "unknown", unread: 0, groups: [], current: null, messages: [], canSend: true, loading: false, error: null };
let snap: GdmSnapshot = INITIAL;
const listeners = new Set<() => void>();
function set(patch: Partial<GdmSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}
export function subscribeGdm(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getGdmSnapshot = (): GdmSnapshot => snap;
export const getGdmServerSnapshot = (): GdmSnapshot => INITIAL;

// ---- 純粋な部分（テストする） ----

export function pruneExpiredG<T extends { created_at: string; pending?: boolean }>(list: T[], now = Date.now()): T[] {
  return list.filter((m) => m.pending || now - new Date(m.created_at).getTime() < DM_TTL_MS);
}

/** 届いた 1 件を入れる: 同じ ID か同じ client_id なら置き換え、無ければ足す。ID 順（送信中は最後）。 */
export function reconcileG(list: GMessage[], m: GMessage): GMessage[] {
  const i = list.findIndex((x) => x.id === m.id || (!!m.client_id && x.client_id === m.client_id));
  const next = i >= 0 ? list.map((x, j) => (j === i ? { ...m, pending: false, failed: false } : x)) : [...list, m];
  return next.sort((a, b) => (a.id < 0 ? Infinity : a.id) - (b.id < 0 ? Infinity : b.id));
}

/** 一覧に 1 件を反映（そのグループを先頭に、人の発言なら未読 +1。見ているなら増やさない）。知らないグループなら null。 */
export function applyToGroups(list: GroupSummary[], m: GMessage, viewing: boolean): GroupSummary[] | null {
  const prev = list.find((g) => g.group.id === m.group_id);
  if (!prev) return null;
  const counts = m.kind === "text" && !m.is_author && !viewing;
  const unread = viewing ? 0 : prev.unread_count + (counts ? 1 : 0);
  return [{ ...prev, last_message: m, unread_count: unread }, ...list.filter((g) => g.group.id !== m.group_id)];
}

/** 同じ ID の発言を直したものに差し替える（リアクションは届いたものを優先、無ければ今のまま）。 */
export function replaceEditedG(list: GMessage[], m: GMessage): GMessage[] {
  return list.map((x) => (x.id === m.id ? { ...x, ...m, reactions: m.reactions ?? x.reactions, pending: false, failed: false } : x));
}

/** 1 件のリアクションを差し替える。 */
export function setGReactions(list: GMessage[], id: number, reactions: OptimisticReaction[]): GMessage[] {
  return list.map((x) => (x.id === id ? { ...x, reactions } : x));
}

/** 一度に出す候補の上限。 */
export const PICKER_LIMIT = 10;

/** 候補（ドリキン 2026-11-06: 会員の総数は非公開なので、全員の一覧を最初から出さない）。
 *  - 何も打っていない: 自分の 1 対 1 の DM の相手だけ（全体の人数は分からない）
 *  - 打った: 名前に含む人を、会員の一覧と DM の相手から（重複なし）
 *  どちらも PICKER_LIMIT 人まで。ビーグル（システム。入れられない）・入れた人・除く人は出さない。 */
export function pickerCandidates(
  members: { userId: string; name: string }[],
  peers: { user_id: string; name: string | null }[],
  exclude: Set<string>,
  query: string,
  selected: { value: string; label: string }[] = []
) {
  const q = query.trim().toLowerCase();
  const pool = q
    ? [...peers.map((p) => ({ id: p.user_id, name: p.name ?? "" })), ...members.map((x) => ({ id: x.userId, name: x.name }))]
    : peers.map((p) => ({ id: p.user_id, name: p.name ?? "" }));
  const seen = new Set<string>(selected.map((x) => x.value));
  const out: { value: string; label: string }[] = [];
  for (const m of pool) {
    if (out.length >= PICKER_LIMIT) break;
    if (!m.id || seen.has(m.id) || exclude.has(m.id) || m.name === "ビーグル") continue;
    if (q && !(m.name || "").toLowerCase().includes(q)) continue;
    seen.add(m.id);
    out.push({ value: m.id, label: m.name || "会員" });
  }
  // 選んだ人は表示（ピル）に要るので、候補の上限とは別に必ず入れる
  return [...selected, ...out];
}

// ---- ネットワーク ----

type Body = Record<string, unknown> & { error?: string; code?: string };
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Body | null }> {
  try {
    const r = await fetch(path, { cache: "no-store", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
    let body: Body | null = null;
    try {
      body = (await r.json()) as Body;
    } catch {
      body = null;
    }
    return { status: r.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

let loading: Promise<void> | null = null;
export function loadGdm(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await api("/api/gdm");
      if (r.status === 404 || r.status === 401) {
        set({ status: "disabled" });
        return;
      }
      if (r.status !== 200 || !r.body) return;
      set({ status: "enabled", groups: (r.body.groups as GroupSummary[]) ?? [], unread: Number(r.body.group_unread_count ?? 0) });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function closeGroup(): void {
  if (snap.current) dropUnsentPhotoJobs(snap.messages);
  if (snap.current) set({ current: null, messages: [], error: null });
}

export async function openGroup(id: number): Promise<void> {
  const known = snap.groups.find((g) => g.group.id === id)?.group ?? null;
  dropUnsentPhotoJobs(snap.messages);
  set({ current: known ?? { id, name: null, title: "グループ", members: [], member_count: 0, is_creator: false, muted: false, created_at: "" }, messages: [], loading: true, error: null, canSend: true });
  const r = await api(`/api/gdm/${id}`);
  if (snap.current?.id !== id) return;
  if (r.status !== 200 || !r.body) {
    set({ loading: false, error: r.body?.error ?? "読み込めませんでした" });
    return;
  }
  set({ current: r.body.group as Group, messages: pruneExpiredG((r.body.messages as GMessage[]) ?? []), canSend: r.body.can_send !== false, loading: false });
  markSeen();
}

let readTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRead: { gid: number; id: number } | null = null;
function sendRead(p: { gid: number; id: number }): void {
  void api(`/api/gdm/${p.gid}/read`, { method: "POST", body: JSON.stringify({ last_read_id: p.id }) }).then((r) => {
    if (r.status === 200 && r.body) set({ unread: Number(r.body.group_unread_count ?? snap.unread) });
  });
}
function markSeen(): void {
  const g = snap.current;
  if (!g) return;
  const last = [...snap.messages].reverse().find((m) => m.id > 0);
  const sum = snap.groups.find((x) => x.group.id === g.id);
  if (sum && sum.unread_count > 0) {
    set({ groups: snap.groups.map((x) => (x.group.id === g.id ? { ...x, unread_count: 0 } : x)), unread: Math.max(0, snap.unread - sum.unread_count) });
  }
  if (!last) return;
  if (readTimer) clearTimeout(readTimer);
  // 別のグループの既読がまだ送れていなければ、待たずに送る（すぐ移っても前のグループの既読を落とさない）
  if (pendingRead && pendingRead.gid !== g.id) sendRead(pendingRead);
  pendingRead = { gid: g.id, id: last.id };
  readTimer = setTimeout(() => {
    const p = pendingRead;
    pendingRead = null;
    if (p) sendRead(p);
  }, 400);
}

let tempSeq = 0;
export async function sendGroupText(text: string, photos: PickedPhoto[] = []): Promise<boolean> {
  const g = snap.current;
  const body = text.trim();
  if (!g || (!body && photos.length === 0)) return false;
  const clientId = newChatClientId();
  const previews = setDmPhotoJob(clientId, photos);
  const temp: GMessage = {
    id: -++tempSeq,
    group_id: g.id,
    kind: "text",
    from_id: null,
    from_name: null,
    from_avatar: null,
    body,
    images: previews,
    created_at: new Date().toISOString(),
    is_author: true,
    client_id: clientId,
    pending: true,
  };
  set({ messages: [...snap.messages, temp], error: null });
  return deliver(g.id, temp);
}

async function deliver(gid: number, temp: GMessage): Promise<boolean> {
  let images: string[] | undefined;
  try {
    images = await uploadDmPhotoJob(temp.client_id);
  } catch (e) {
    if (!(snap.current?.id === gid)) {
      dropDmPhotoJob(temp.client_id); // 会話を離れた後の失敗: 写真を残さない
      return false;
    }
    if (permanentUploadFailure(e)) {
      // 再送しても通らない: 吹き出しを消して、本文と写真を入力欄へ戻す（チャットと同じ）。
      const back = { body: temp.body, photos: takeDmPhotoJob(temp.client_id) };
      if (restoreHandler) restoreHandler(back);
      else back.photos.forEach((ph) => URL.revokeObjectURL(ph.preview));
      set({
        messages: snap.messages.filter((x) => !(x.client_id === temp.client_id && x.id < 0)),
        error: photoUploadError(e),
      });
    } else {
      set({
        messages: snap.messages.map((x) => (x.client_id === temp.client_id && x.id < 0 ? { ...x, pending: false, failed: true } : x)),
        error: photoUploadError(e),
      });
    }
    return false;
  }
  const r = await api(`/api/gdm/${gid}/messages`, {
    method: "POST",
    body: JSON.stringify({ body: temp.body, client_id: temp.client_id, ...(images ? { images } : {}) }),
  });
  if (r.status === 201 && r.body?.message) {
    dropDmPhotoJob(temp.client_id);
    const m = r.body.message as GMessage;
    if (snap.current?.id === gid) set({ messages: reconcileG(snap.messages, m) });
    const next = applyToGroups(snap.groups, m, true);
    if (next) set({ groups: next });
    return true;
  }
  if (snap.current?.id === gid) {
    set({
      // stream で本物に置き換わっていたら（id > 0）失敗にしない
      messages: snap.messages.map((x) => (x.client_id === temp.client_id && x.id < 0 ? { ...x, pending: false, failed: true } : x)),
      error: r.body?.error ?? "送れませんでした",
    });
  }
  return false;
}

export function retryGroupText(m: GMessage): void {
  const g = snap.current;
  if (!g || !m.failed) return;
  set({ messages: snap.messages.map((x) => (x.client_id === m.client_id ? { ...x, failed: false, pending: true } : x)), error: null });
  void deliver(g.id, { ...m, failed: false, pending: true });
}

export function discardGroupText(m: GMessage): void {
  dropDmPhotoJob(m.client_id);
  set({ messages: snap.messages.filter((x) => x.client_id !== m.client_id || x.id > 0) });
}

/** 作る。成功したらそのグループを開く。失敗はエラー文を返す。 */
export async function createGroup(memberIds: string[], name: string): Promise<string | null> {
  const r = await api("/api/gdm", { method: "POST", body: JSON.stringify({ member_ids: memberIds, name: name.trim() || null }) });
  if (r.status !== 201 || !r.body?.group) return r.body?.error ?? "作れませんでした";
  const g = r.body.group as Group;
  if (!snap.groups.some((x) => x.group.id === g.id)) set({ groups: [{ group: g, last_message: null, unread_count: 0 }, ...snap.groups] });
  void openGroup(g.id);
  return null;
}

function replaceGroup(g: Group): void {
  set({
    groups: snap.groups.some((x) => x.group.id === g.id)
      ? snap.groups.map((x) => (x.group.id === g.id ? { ...x, group: g } : x))
      : [{ group: g, last_message: null, unread_count: 0 }, ...snap.groups],
    ...(snap.current?.id === g.id ? { current: g } : {}),
  });
}

function dropGroup(id: number): void {
  const sum = snap.groups.find((x) => x.group.id === id);
  set({
    groups: snap.groups.filter((x) => x.group.id !== id),
    unread: Math.max(0, snap.unread - (sum?.unread_count ?? 0)),
    ...(snap.current?.id === id ? { current: null, messages: [] } : {}),
  });
}

async function mutate(path: string, method: string, payload?: unknown): Promise<string | null> {
  const r = await api(path, { method, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
  if (r.status !== 200 || !r.body) return r.body?.error ?? "できませんでした";
  if (r.body.group) replaceGroup(r.body.group as Group);
  return null;
}

/** 写真を設定する（取り替えも）。サーバが正方形に切り取って縮める。 */
export async function setGroupPhoto(id: number, file: File): Promise<string | null> {
  const fd = new FormData();
  fd.append("photo", file);
  try {
    const r = await fetch(`/api/gdm/${id}/photo`, { method: "POST", body: fd, cache: "no-store" });
    const body = (await r.json().catch(() => null)) as Body | null;
    if (r.status !== 200 || !body) return body?.error ?? "写真を変えられませんでした";
    if (body.group) replaceGroup(body.group as Group);
    return null;
  } catch {
    return "写真を変えられませんでした";
  }
}
export const removeGroupPhoto = (id: number) => mutate(`/api/gdm/${id}/photo`, "DELETE");

export const renameGroup = (id: number, name: string) => mutate(`/api/gdm/${id}`, "PATCH", { name: name.trim() || null });
export const setGroupMuted = (id: number, muted: boolean) => mutate(`/api/gdm/${id}`, "PATCH", { muted });
export const setGroupBeagle = (id: number, beagle: boolean) => mutate(`/api/gdm/${id}`, "PATCH", { beagle });
export const addGroupMembers = (id: number, userIds: string[]) => mutate(`/api/gdm/${id}/members`, "POST", { user_ids: userIds });
export async function removeGroupMember(id: number, userId: string, self: boolean): Promise<string | null> {
  const err = await mutate(`/api/gdm/${id}/members/${encodeURIComponent(userId)}`, "DELETE");
  if (!err && self) dropGroup(id);
  return err;
}

/** ✏️ 自分の発言を直す。失敗はエラー文を返す（成功は null）。 */
export async function editGroupText(id: number, text: string): Promise<string | null> {
  const r = await api(`/api/gdm/messages/${id}`, { method: "PATCH", body: JSON.stringify({ body: text.trim() }) });
  if (r.status !== 200 || !r.body?.message) return r.body?.error ?? "直せませんでした";
  applyEditedG(r.body.message as GMessage);
  return null;
}

function applyEditedG(m: GMessage): void {
  if (snap.current?.id === m.group_id) set({ messages: replaceEditedG(snap.messages, m) });
  set({
    groups: snap.groups.map((g) =>
      g.last_message?.id === m.id ? { ...g, last_message: { ...g.last_message, body: m.body, edited: m.edited, edited_at: m.edited_at } } : g
    ),
  });
}

/** 😀 リアクションを付ける・外す（楽観的に出して、サーバの返事で置き換える。失敗したら戻す）。 */
export async function toggleGroupReaction(id: number, emoji: string, myName: string): Promise<void> {
  const gid = snap.current?.id;
  const before = snap.messages.find((x) => x.id === id)?.reactions ?? [];
  set({ messages: setGReactions(snap.messages, id, toggleReactionOptimistic(before, emoji, myName)), error: null });
  const r = await api(`/api/gdm/messages/${id}/reactions`, { method: "POST", body: JSON.stringify({ emoji }) });
  if (snap.current?.id !== gid) return;
  if (r.status === 200 && Array.isArray(r.body?.reactions)) {
    set({ messages: setGReactions(snap.messages, id, r.body.reactions as OptimisticReaction[]) });
  } else {
    set({ messages: setGReactions(snap.messages, id, before), error: r.body?.error ?? "リアクションできませんでした" });
  }
}

/** /api/posts/stream の `event: gdm`。 */
export function applyGdmEvent(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  if (snap.status !== "enabled") {
    void loadGdm();
    return;
  }
  if (d.action === "create" && d.message) {
    const m = d.message as GMessage;
    const viewing = snap.current?.id === m.group_id && typeof document !== "undefined" && document.visibilityState === "visible";
    if (snap.current?.id === m.group_id) set({ messages: reconcileG(snap.messages, m) });
    const next = applyToGroups(snap.groups, m, viewing);
    if (!next) {
      void loadGdm(); // 知らないグループ（入れてもらった直後など）
      return;
    }
    const counts = m.kind === "text" && !m.is_author && !viewing;
    set({ groups: next, unread: typeof d.group_unread_count === "number" && !viewing ? d.group_unread_count : snap.unread + (counts ? 1 : 0) });
    if (viewing && !m.is_author) markSeen();
  } else if (d.action === "edit" && d.message && typeof d.message === "object") {
    applyEditedG(d.message as GMessage);
  } else if (d.action === "reaction" && typeof d.message_id === "number" && Array.isArray(d.reactions)) {
    if (snap.current?.id === d.group_id) set({ messages: setGReactions(snap.messages, d.message_id, d.reactions as OptimisticReaction[]) });
  } else if (d.action === "read" && typeof d.group_id === "number") {
    set({
      groups: snap.groups.map((x) => (x.group.id === d.group_id ? { ...x, unread_count: Number(d.unread_count ?? 0) } : x)),
      unread: typeof d.group_unread_count === "number" ? d.group_unread_count : snap.unread,
    });
  } else if (d.action === "group" && d.group && typeof d.group === "object") {
    replaceGroup(d.group as Group);
  } else if (d.action === "removed" && typeof d.group_id === "number") {
    dropGroup(d.group_id);
  }
}

export function pruneGdmNow(): void {
  const messages = pruneExpiredG(snap.messages);
  if (messages.length !== snap.messages.length) set({ messages });
}

export function _resetGdmClientForTest(): void {
  snap = INITIAL;
  listeners.clear();
  loading = null;
}

type Restore = { body: string; photos: PickedPhoto[] };
let restoreHandler: ((r: Restore) => void) | null = null;
/** 入力欄が、送れなかった本文と写真を受け取る（開いている会話の入力欄だけ）。戻り値で外す。 */
export function onGroupRestore(fn: (r: Restore) => void): () => void {
  restoreHandler = fn;
  return () => {
    if (restoreHandler === fn) restoreHandler = null;
  };
}
