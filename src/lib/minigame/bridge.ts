/* 🎮 締め切りダッシュ — アプリの WebView 用の橋渡し（bridge_version 1）。
 * /minigame/index.html が読み込む game.js の入口（scripts/build-minigame.mjs で束ねる）。
 * 約束の正本は docs/minigame-spec.md「橋渡し」。トークンは受け取らない・持たない・送らない（API はアプリが中継）。
 *
 *   アプリ → ゲーム: window.bguruMinigame.receive(msg)（msg はオブジェクトか JSON 文字列）、
 *                   または window.postMessage(msg)（Android の postWebMessage・iframe）。
 *   ゲーム → アプリ: iOS/Mac  window.webkit.messageHandlers.minigame.postMessage(obj)
 *                   Android  window.MinigameBridge.postMessage(JSON 文字列)
 *                   iframe   window.parent.postMessage({ source: "bguru-minigame", ...obj }, "*")
 *                   （どれもなければ window の CustomEvent "bguru-minigame"） */
import { DashGame, HostError, type FinishPayload, type GameHost, type HapticKind } from "./game";
import { ENGINE_VERSION, replay, traceRun, type Character } from "./sim";
import type { FinishResultDto, LeaderboardDto, MinigameInfo, MinigameMode, MinigamePeriod, PlayTicket } from "./types";

export const BRIDGE_VERSION = 1;

type Out =
  | { type: "ready"; v: number; engine_version: number }
  | { type: "request_play"; v: number; req: number; mode: MinigameMode; character: Character }
  | ({ type: "finished"; v: number; req: number } & FinishPayload)
  | { type: "request_leaderboard"; v: number; req: number; period: MinigamePeriod }
  | { type: "request_info"; v: number }
  | { type: "haptic"; v: number; kind: HapticKind }
  | { type: "size"; v: number; height: number }
  | { type: "error"; v: number; message: string };

type W = Window & {
  webkit?: { messageHandlers?: { minigame?: { postMessage: (m: unknown) => void } } };
  MinigameBridge?: { postMessage: (s: string) => void };
  bguruMinigame?: unknown;
};

function post(msg: Out): void {
  const w = window as W;
  try {
    if (w.webkit?.messageHandlers?.minigame) {
      w.webkit.messageHandlers.minigame.postMessage(msg);
      return;
    }
    if (w.MinigameBridge?.postMessage) {
      w.MinigameBridge.postMessage(JSON.stringify(msg));
      return;
    }
    if (w.parent && w.parent !== w) {
      w.parent.postMessage({ source: "bguru-minigame", ...msg }, "*");
      return;
    }
  } catch {
    /* fall through to the DOM event */
  }
  w.dispatchEvent(new CustomEvent("bguru-minigame", { detail: msg }));
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** アプリに頼んで返事（state の play / result / leaderboard の req）を待つ。 */
class BridgeHost implements GameHost {
  private seq = 0;
  pending = new Map<number, Pending>();

  private ask<T>(build: (req: number) => Out, timeoutMs = 15000): Promise<T> {
    const req = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req);
        reject(new HostError("アプリからの返事がありません", "timeout"));
      }, timeoutMs);
      this.pending.set(req, { resolve: resolve as (v: unknown) => void, reject, timer });
      post(build(req));
    });
  }

  settle(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const m = raw as Record<string, unknown>;
    const req = typeof m.req === "number" ? m.req : null;
    if (req === null) return;
    const p = this.pending.get(req);
    if (!p) return;
    this.pending.delete(req);
    clearTimeout(p.timer);
    if (typeof m.error === "string" || m.ok === false) p.reject(new HostError(String(m.error ?? "エラー"), String(m.code ?? "error")));
    else p.resolve(m);
  }

  requestPlay(mode: MinigameMode, character: Character): Promise<PlayTicket> {
    return this.ask((req) => ({ type: "request_play", v: BRIDGE_VERSION, req, mode, character }));
  }
  finish(p: FinishPayload): Promise<FinishResultDto> {
    return this.ask((req) => ({ type: "finished", v: BRIDGE_VERSION, req, ...p }), 30000);
  }
  leaderboard(period: MinigamePeriod): Promise<LeaderboardDto> {
    return this.ask((req) => ({ type: "request_leaderboard", v: BRIDGE_VERSION, req, period }));
  }
  refresh(): void {
    post({ type: "request_info", v: BRIDGE_VERSION });
  }
  haptic(kind: HapticKind): void {
    post({ type: "haptic", v: BRIDGE_VERSION, kind });
  }
  resized(height: number): void {
    post({ type: "size", v: BRIDGE_VERSION, height });
  }
}

const INFO_KEYS: (keyof MinigameInfo)[] = ["engine_version", "me", "daily", "best", "plays_today", "top_today"];

/** state の中の情報（GET me と同じ形）だけを取り出す。 */
export function infoFromState(m: Record<string, unknown>): Partial<MinigameInfo> {
  const out: Record<string, unknown> = {};
  for (const k of INFO_KEYS) if (k in m) out[k] = m[k];
  return out as Partial<MinigameInfo>;
}

export function startBridge(el: HTMLElement): DashGame {
  const params = new URLSearchParams(location.search);
  const theme = (v: unknown) => (v === "light" || v === "dark" ? v : "auto");
  const host = new BridgeHost();
  const maxH = Number(params.get("max_height"));
  const game = new DashGame(el, host, { theme: theme(params.get("theme")), maxHeight: maxH > 0 ? maxH : undefined, focused: true });

  const receive = (raw: unknown): void => {
    let m: unknown = raw;
    if (typeof raw === "string") {
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!m || typeof m !== "object") return;
    const msg = m as Record<string, unknown>;
    switch (msg.type) {
      case "state": {
        const info = infoFromState(msg);
        if (Object.keys(info).length) game.setInfo(info);
        if ("theme" in msg) game.setTheme(theme(msg.theme));
        if (typeof msg.max_height === "number") game.setMaxHeight(msg.max_height);
        for (const k of ["play", "result", "leaderboard"]) {
          const v = msg[k] as Record<string, unknown> | undefined;
          if (!v || typeof v !== "object") continue;
          if (typeof v.req === "number") host.settle(v);
          else if (k === "leaderboard" && v.period === "today" && Array.isArray(v.entries)) game.setTopToday(v.entries as never);
        }
        break;
      }
      case "event": {
        // 配信の minigame イベント（data をそのまま）。今日の上位が変わった。
        const d = (msg.data ?? msg) as Record<string, unknown>;
        if (d.action === "leaderboard" && Array.isArray(d.top)) game.setTopToday(d.top as never);
        else if (d.action === "best") host.refresh();
        break;
      }
      case "pause":
        game.pause();
        break;
      case "resume":
        game.resume();
        break;
      default:
        break;
    }
  };
  (window as W).bguruMinigame = { receive, version: BRIDGE_VERSION, engine_version: ENGINE_VERSION, replay, game };
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { source?: string } | string;
    if (typeof d === "object" && d && d.source === "bguru-minigame") return;
    receive(d);
  });
  window.addEventListener("error", (e) => post({ type: "error", v: BRIDGE_VERSION, message: String(e.message).slice(0, 200) }));
  post({ type: "ready", v: BRIDGE_VERSION, engine_version: ENGINE_VERSION });
  return game;
}

// 計算だけ（決定論のテスト・確認用。画面がなくても使える）。
if (typeof window !== "undefined") {
  (window as Window & { bguruMinigameEngine?: unknown }).bguruMinigameEngine = { engine_version: ENGINE_VERSION, replay, traceRun };
}

const root = typeof document !== "undefined" ? document.getElementById("minigame") : null;
if (root) startBridge(root);
