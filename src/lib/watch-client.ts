"use client";
/* 📺 YouTube 共同鑑賞の Web クライアントの状態（React の外。minigame-client.ts と同じ形で useSyncExternalStore から読む）。
 *
 *   loadWatch()         GET /api/watch/state — 200 = 使える、404 = 出していない（「📺」を出さない）
 *   applyWatchEvent()   /api/posts/stream の `event: watch`（変わった後の状態）
 *   watchAction()       プレイヤーのページの操作を POST /api/watch/action へ（応答の状態もページへ）
 *   watchTogether(url)  チャット・タイムラインの YouTube リンクの「みんなで見る」
 * 窓: docked（チャットの上）/ floating（浮かぶ窓。ドラッグ・大きさ変更）。プレイヤーの iframe は作り直さない。 */
import type { WatchStateDto } from "./watch";

export type WatchAvailability = "unknown" | "enabled" | "disabled";
export type WatchMode = "docked" | "floating";

export interface WatchSnapshot {
  status: WatchAvailability;
  open: boolean;
  mode: WatchMode;
  state: WatchStateDto | null;
  /** 最後に断られた操作の理由（ページに出す）。 */
  error: { message: string; at: number } | null;
}

let snap: WatchSnapshot = {
  status: "unknown",
  open: false,
  mode: "docked",
  state: null,
  error: null,
};
const SERVER_SNAPSHOT = snap;
const listeners = new Set<() => void>();

function set(patch: Partial<WatchSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getSnapshot = (): WatchSnapshot => snap;
export const getServerSnapshot = (): WatchSnapshot => SERVER_SNAPSHOT;

type Body = Record<string, unknown> & {
  error?: string;
  code?: string;
  state?: WatchStateDto;
};

async function api(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: Body | null }> {
  const r = await fetch(`/api/watch/${path}`, {
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
}

/** 新しい版だけ受け取る（遅れて届いた応答で戻さない）。動画が変わったときは版が小さくても受け取らない理由がないので受け取る。 */
function takeState(s: WatchStateDto | undefined | null): void {
  if (!s) return;
  const cur = snap.state;
  if (cur && s.version < cur.version) return;
  set({ state: s });
}

let loading: Promise<void> | null = null;

export function loadWatch(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await api("state");
      if (r.status === 404 || r.status === 401) {
        set({ status: "disabled" });
        return;
      }
      if (r.status !== 200 || !r.body) return;
      set({ status: "enabled" });
      takeState(r.body.state);
    } catch {
      /* offline: keep what we have */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** つなぎ直したとき: 抜けた分を取り直す。 */
export function reloadWatch(): void {
  if (snap.status === "enabled") void loadWatch();
}

export function applyWatchEvent(data: unknown): void {
  const s = (data as { state?: WatchStateDto } | null)?.state;
  if (s && snap.status !== "disabled") {
    if (snap.status === "unknown") set({ status: "enabled" });
    takeState(s);
  }
}

export function setWatchOpen(open: boolean): void {
  set({ open });
}

export function setWatchMode(mode: WatchMode): void {
  set({ mode, open: true });
}

export async function watchAction(
  body: Record<string, unknown>,
): Promise<boolean> {
  try {
    const r = await api("action", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (r.status === 200 && r.body?.state) {
      takeState(r.body.state);
      return true;
    }
    set({
      error: {
        message: r.body?.error ?? `うまくいきませんでした（${r.status}）`,
        at: Date.now(),
      },
    });
  } catch {
    set({ error: { message: "通信できませんでした", at: Date.now() } });
  }
  return false;
}

/** 「みんなで見る」: 何も流れていなければいま流し、流れていれば見たいものリストへ。開いて見せる。 */
export async function watchTogether(url: string): Promise<void> {
  if (snap.status === "unknown") await loadWatch();
  if (snap.status !== "enabled") return;
  set({ open: true });
  await watchAction({ action: snap.state?.video ? "queue_add" : "load", url });
}

/** YouTube の動画のリンクか（チャットの本文の URL に「みんなで見る」を付ける目印。確かめはサーバがする）。 */
export function isYoutubeVideoUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") return /^\/[\w-]{11}/.test(u.pathname);
    if (!/(^|\.)youtube\.com$/.test(u.hostname)) return false;
    return (
      /^[\w-]{11}$/.test(u.searchParams.get("v") ?? "") ||
      /^\/(shorts|live|embed)\/[\w-]{11}/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
