"use client";
/* 🎮 締め切りダッシュの Web クライアントの状態（React の外。shogi-client.ts と同じ形で useSyncExternalStore から読む）。
 *
 *   loadMinigame()        GET /api/minigame/me — 200 = 使える（情報）、404 = 出していない（「🎮」を出さない）
 *   applyMinigameEvent()  /api/posts/stream の `event: minigame`（今日の上位 10・自分のベスト）
 *   WebHost               ゲームの部品（lib/minigame/game.ts）が呼ぶ API（発行・提出・順位表）
 * 開くと ☗ 将棋の画面は閉じる（上にゲーム・下にチャット。2 つ重ねるとチャットが見えない）。 */
import { HostError, type FinishPayload, type GameHost, type HapticKind } from "./minigame/host";
import type { Character } from "./minigame/sim";
import type { FinishResultDto, LeaderboardDto, LeaderEntry, MinigameInfo, MinigameMode, MinigamePeriod, PlayTicket } from "./minigame/types";
import { setShogiOpen } from "./shogi-client";

export type MinigameAvailability = "unknown" | "enabled" | "disabled";

export interface MinigameSnapshot {
  status: MinigameAvailability;
  open: boolean;
  info: MinigameInfo | null;
  /** 配信で届いた今日の上位（null = まだ届いていない）。 */
  topToday: LeaderEntry[] | null;
}

let snap: MinigameSnapshot = { status: "unknown", open: false, info: null, topToday: null };
const SERVER_SNAPSHOT = snap;
const listeners = new Set<() => void>();

function set(patch: Partial<MinigameSnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getSnapshot = (): MinigameSnapshot => snap;
export const getServerSnapshot = (): MinigameSnapshot => SERVER_SNAPSHOT;

type Body = Record<string, unknown> & { error?: string; code?: string };

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: Body | null }> {
  const r = await fetch(`/api/minigame/${path}`, {
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

function fail(r: { status: number; body: Body | null }): never {
  throw new HostError(r.body?.error ?? (r.status === 0 ? "通信できませんでした" : `エラー（${r.status}）`), r.body?.code ?? "error");
}

let loading: Promise<void> | null = null;

export function loadMinigame(): Promise<void> {
  loading ??= (async () => {
    try {
      const r = await api("me");
      if (r.status === 404 || r.status === 401) {
        set({ status: "disabled" });
        return;
      }
      if (r.status !== 200 || !r.body) return;
      set({ status: "enabled", info: r.body as unknown as MinigameInfo });
    } catch {
      /* offline: keep what we have */
    } finally {
      loading = null;
    }
  })();
  return loading;
}

export function setMinigameOpen(open: boolean): void {
  if (open) setShogiOpen(false);
  set({ open });
  if (open && snap.status === "enabled") void loadMinigame();
}

/** SSE の `event: minigame`（data は { type, action, ... }）。 */
export function applyMinigameEvent(ev: unknown): void {
  if (!ev || typeof ev !== "object") return;
  const e = ev as { action?: string; top?: LeaderEntry[] };
  if (e.action === "leaderboard" && Array.isArray(e.top)) set({ topToday: e.top });
  else if (e.action === "best" && snap.open) void loadMinigame();
}

/** SSE が再接続したとき。 */
export function reloadMinigame(): void {
  if (snap.status === "enabled" && snap.open) void loadMinigame();
}

/** ゲームの部品が呼ぶ API（Web はセッションのクッキーで直接呼ぶ）。 */
export class WebHost implements GameHost {
  async requestPlay(mode: MinigameMode, character: Character): Promise<PlayTicket> {
    const r = await api("plays", { method: "POST", body: JSON.stringify({ mode, character }) });
    if (r.status !== 201 || !r.body?.play) fail(r);
    return r.body.play as PlayTicket;
  }
  async finish(p: FinishPayload): Promise<FinishResultDto> {
    const r = await api(`plays/${p.play_id}/finish`, {
      method: "POST",
      body: JSON.stringify({ inputs: p.inputs, engine_version: p.engine_version, score: p.score, ticks: p.ticks }),
    });
    if (r.status !== 200 || !r.body?.result) fail(r);
    return r.body.result as FinishResultDto;
  }
  async leaderboard(period: MinigamePeriod): Promise<LeaderboardDto> {
    const r = await api(`leaderboard?period=${period}`);
    if (r.status !== 200 || !r.body) fail(r);
    return r.body as unknown as LeaderboardDto;
  }
  refresh(): void {
    void loadMinigame();
  }
  haptic(kind: HapticKind): void {
    // 振動できる端末（Android の Chrome）だけ。iPhone の Safari は何もしない。
    try {
      if (kind === "hit" || kind === "dead") navigator.vibrate?.(kind === "dead" ? [30, 40, 30] : 20);
      else if (kind === "highscore") navigator.vibrate?.([15, 30, 15, 30, 40]);
    } catch {
      /* not allowed */
    }
  }
}
