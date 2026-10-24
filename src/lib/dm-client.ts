"use client";
/* ✉️ 簡易 DM の Web クライアントの状態（React の外。minigame-client.ts と同じ形で useSyncExternalStore から読む）。
 *
 *   loadDm()         GET /api/dm — 200 = 使える（一覧・未読）、404 = 出していない（DM の部品を出さない）
 *   openDmList() / openDm(peer) / closeDm()   一覧・1 つの会話を開く（チャットの上に重ねる）
 *   sendDmMessage()  楽観的に出して POST、client_id で突き合わせる（チャットと同じ考え方）
 *   applyDmEvent()   /api/posts/stream の `event: dm`（受け取る人ごとの DTO）
 * DM は 24 時間で消える: 期限を過ぎたものはここでも隠す。 */
import { newChatClientId } from "./chat-optimistic";

export type DmPeer = { user_id: string; name: string | null; avatar: string | null };
export type DmMessage = {
  id: number;
  from_id: string;
  to_id: string;
  peer_id: string;
  body: string;
  created_at: string;
  is_author: boolean;
  client_id?: string;
  /** 送信中（まだサーバの ID が無い: 負の ID）・失敗。 */
  pending?: boolean;
  failed?: boolean;
};
export type DmConversation = { peer: DmPeer; last_message: DmMessage; unread_count: number };

export const DM_TTL_MS = 24 * 60 * 60 * 1000;

export interface DmSnapshot {
  status: "unknown" | "enabled" | "disabled";
  unread: number;
  conversations: DmConversation[];
  /** 開いているか。peer が null なら一覧、あれば会話。 */
  open: boolean;
  peer: DmPeer | null;
  messages: DmMessage[];
  canSend: boolean;
  loadingThread: boolean;
  error: string | null;
}

const INITIAL: DmSnapshot = {
  status: "unknown",
  unread: 0,
  conversations: [],
  open: false,
  peer: null,
  messages: [],
  canSend: true,
  loadingThread: false,
  error: null,
};
let snap: DmSnapshot = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<DmSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getSnapshot = (): DmSnapshot => snap;
export const getServerSnapshot = (): DmSnapshot => INITIAL;

// ---- 純粋な部分（テストする） ----

/** 24 時間を過ぎたものを落とす（送信中のものは残す）。 */
export function pruneExpired<T extends { created_at: string; pending?: boolean }>(list: T[], now = Date.now()): T[] {
  return list.filter((m) => m.pending || now - new Date(m.created_at).getTime() < DM_TTL_MS);
}

/** 届いた 1 件を会話に入れる: 同じ ID か同じ client_id（自分の楽観的な吹き出し）なら置き換え、無ければ足す。ID 順。 */
export function reconcileDm(list: DmMessage[], m: DmMessage): DmMessage[] {
  const i = list.findIndex((x) => x.id === m.id || (!!m.client_id && x.client_id === m.client_id));
  const next = i >= 0 ? list.map((x, j) => (j === i ? { ...m, pending: false, failed: false } : x)) : [...list, m];
  return next.sort((a, b) => (a.id < 0 ? Infinity : a.id) - (b.id < 0 ? Infinity : b.id));
}

/** 一覧に 1 件を反映（その相手の会話を先頭に、相手からなら未読 +1。開いて見ているなら増やさない）。 */
export function applyToConversations(
  list: DmConversation[],
  m: DmMessage,
  peer: DmPeer,
  viewing: boolean
): DmConversation[] {
  const prev = list.find((c) => c.peer.user_id === peer.user_id);
  const before = prev?.unread_count ?? 0;
  const unread = m.is_author ? before : viewing ? 0 : before + 1;
  const conv: DmConversation = { peer, last_message: m, unread_count: unread };
  return [conv, ...list.filter((c) => c.peer.user_id !== peer.user_id)];
}

// ---- ネットワーク ----

type Body = Record<string, unknown> & { error?: string; code?: string };
async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Body | null }> {
  try {
    const r = await fetch(path, {
      cache: "no-store",
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
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
export function loadDm(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await api("/api/dm");
      if (r.status === 404 || r.status === 401) {
        set({ status: "disabled" });
        return;
      }
      if (r.status !== 200 || !r.body) return;
      set({
        status: "enabled",
        conversations: pruneConversations((r.body.conversations as DmConversation[]) ?? []),
        unread: Number(r.body.unread_count ?? 0),
      });
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function pruneConversations(list: DmConversation[]): DmConversation[] {
  const now = Date.now();
  return list.filter((c) => now - new Date(c.last_message.created_at).getTime() < DM_TTL_MS);
}

export function openDmList(): void {
  set({ open: true, peer: null, messages: [], error: null });
  void loadDm();
}

export function closeDm(): void {
  set({ open: false, peer: null, messages: [], error: null });
}

/** 会話を開く（チャットの名前から: 名前とアイコンは分かっている）。 */
export async function openDm(peer: DmPeer): Promise<void> {
  set({ open: true, peer, messages: [], loadingThread: true, error: null, canSend: true });
  const r = await api(`/api/dm/${encodeURIComponent(peer.user_id)}`);
  if (snap.peer?.user_id !== peer.user_id) return; // 別の会話へ移った
  if (r.status !== 200 || !r.body) {
    set({ loadingThread: false, error: r.body?.error ?? "読み込めませんでした" });
    return;
  }
  const messages = pruneExpired((r.body.messages as DmMessage[]) ?? []);
  set({
    peer: (r.body.peer as DmPeer) ?? peer,
    messages,
    canSend: r.body.can_send !== false,
    loadingThread: false,
  });
  markSeen();
}

let readTimer: ReturnType<typeof setTimeout> | null = null;
/** 開いている会話を最後まで読んだことにする（少しまとめて送る）。 */
function markSeen(): void {
  const peer = snap.peer;
  if (!peer) return;
  const last = [...snap.messages].reverse().find((m) => m.id > 0 && !m.is_author);
  // 一覧の未読はすぐ消す
  const conv = snap.conversations.find((c) => c.peer.user_id === peer.user_id);
  if (conv && conv.unread_count > 0) {
    set({
      conversations: snap.conversations.map((c) => (c.peer.user_id === peer.user_id ? { ...c, unread_count: 0 } : c)),
      unread: Math.max(0, snap.unread - conv.unread_count),
    });
  }
  if (!last) return;
  if (readTimer) clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    const r = await api(`/api/dm/${encodeURIComponent(peer.user_id)}/read`, {
      method: "POST",
      body: JSON.stringify({ last_read_id: last.id }),
    });
    if (r.status === 200 && r.body) set({ unread: Number(r.body.unread_count ?? snap.unread) });
  }, 400);
}

let tempSeq = 0;
export async function sendDmMessage(text: string): Promise<boolean> {
  const peer = snap.peer;
  const body = text.trim();
  if (!peer || !body) return false;
  const clientId = newChatClientId();
  const temp: DmMessage = {
    id: -++tempSeq,
    from_id: "",
    to_id: peer.user_id,
    peer_id: peer.user_id,
    body,
    created_at: new Date().toISOString(),
    is_author: true,
    client_id: clientId,
    pending: true,
  };
  set({ messages: [...snap.messages, temp], error: null });
  return deliver(peer, temp);
}

async function deliver(peer: DmPeer, temp: DmMessage): Promise<boolean> {
  const r = await api(`/api/dm/${encodeURIComponent(peer.user_id)}`, {
    method: "POST",
    body: JSON.stringify({ body: temp.body, client_id: temp.client_id }),
  });
  if (r.status === 201 && r.body?.message) {
    const m = r.body.message as DmMessage;
    if (snap.peer?.user_id === peer.user_id) set({ messages: reconcileDm(snap.messages, m) });
    set({ conversations: applyToConversations(snap.conversations, m, peer, true) });
    return true;
  }
  if (snap.peer?.user_id === peer.user_id) {
    set({
      messages: snap.messages.map((x) => (x.client_id === temp.client_id ? { ...x, pending: false, failed: true } : x)),
      error: r.body?.error ?? "送れませんでした",
    });
  }
  return false;
}

export function retryDm(m: DmMessage): void {
  const peer = snap.peer;
  if (!peer || !m.failed) return;
  set({ messages: snap.messages.map((x) => (x.client_id === m.client_id ? { ...x, failed: false, pending: true } : x)), error: null });
  void deliver(peer, { ...m, failed: false, pending: true });
}

export function discardDm(m: DmMessage): void {
  set({ messages: snap.messages.filter((x) => x.client_id !== m.client_id || x.id > 0) });
}

/** /api/posts/stream の `event: dm`。 */
export function applyDmEvent(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const d = data as Record<string, unknown>;
  if (snap.status !== "enabled") {
    // 開いていなかったタブ: 一覧を読み直せば未読も揃う
    void loadDm();
    return;
  }
  if (d.action === "create" && d.message && d.peer) {
    const m = d.message as DmMessage;
    const peer = d.peer as DmPeer;
    const viewing = snap.open && snap.peer?.user_id === peer.user_id && typeof document !== "undefined" && document.visibilityState === "visible";
    if (snap.peer?.user_id === peer.user_id) set({ messages: reconcileDm(snap.messages, m) });
    set({
      conversations: applyToConversations(snap.conversations, m, peer, viewing),
      unread: typeof d.unread_count === "number" && !viewing ? d.unread_count : m.is_author || viewing ? snap.unread : snap.unread + 1,
    });
    if (viewing && !m.is_author) markSeen();
  } else if (d.action === "read" && typeof d.peer_id === "string") {
    set({
      conversations: snap.conversations.map((c) => (c.peer.user_id === d.peer_id ? { ...c, unread_count: 0 } : c)),
      unread: typeof d.unread_count === "number" ? d.unread_count : snap.unread,
    });
  }
}

/** 期限切れを隠す（開いている間、1 分ごと）。 */
export function pruneNow(): void {
  const messages = pruneExpired(snap.messages);
  const conversations = pruneConversations(snap.conversations);
  if (messages.length !== snap.messages.length || conversations.length !== snap.conversations.length) set({ messages, conversations });
}

/** テスト用。 */
export function _resetDmClientForTest(): void {
  snap = INITIAL;
  listeners.clear();
  loading = null;
}
