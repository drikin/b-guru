"use client";
/* ☗ 将棋の Web クライアントの状態（React の外。room-client.ts と同じ形で useSyncExternalStore から読む）。
 *
 *   loadShogi()        GET /api/shogi/games — 200 = 使える（一覧）、404 = 出していない（「☗ 将棋」を出さない）
 *   applyShogiEvent()  /api/posts/stream の `event: shogi`（{ type, action, game }）
 *   操作               POST /api/shogi/games…（募集・指名・受ける・断る・取り下げる・指す・投了・観戦の合図）
 *
 * 正本はサーバ。指した手はサーバの返事（か配信）で確定し、409 なら最新の状態に戻す。
 * 時計は server_now との差（skew）で補正して手元で数える。 */
import type { ShogiGameDetailDto, ShogiGameDto, ShogiMoveDto } from "./shogi-types";
import type { Side } from "./shogi-rules";

export type ShogiAvailability = "unknown" | "enabled" | "disabled";

export type ShogiSettings = { confirmMove: boolean; moveHints: boolean };

export interface ShogiSnapshot {
  status: ShogiAvailability;
  me: string | null;
  /** テスト用: 自分の募集を自分で受けられる（SHOGI_SELF_PLAY）。 */
  selfPlay: boolean;
  games: ShogiGameDto[];
  /** 「☗ 将棋」を開いている。 */
  open: boolean;
  /** 見ている対局（null = ロビー）。 */
  selectedId: number | null;
  detail: ShogiGameDetailDto | null;
  busy: boolean;
  notice: string | null;
  settings: ShogiSettings;
  /** サーバの時計 − 手元の時計（ms）。 */
  skew: number;
}

const SETTINGS_KEY = "bguru-shogi-settings";

function loadSettings(): ShogiSettings {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SETTINGS_KEY) : null;
    const v = raw ? (JSON.parse(raw) as Partial<ShogiSettings>) : {};
    return { confirmMove: v.confirmMove === true, moveHints: v.moveHints !== false };
  } catch {
    return { confirmMove: false, moveHints: true };
  }
}

let snap: ShogiSnapshot = {
  status: "unknown",
  me: null,
  selfPlay: false,
  games: [],
  open: false,
  selectedId: null,
  detail: null,
  busy: false,
  notice: null,
  settings: { confirmMove: false, moveHints: true },
  skew: 0,
};
const SERVER_SNAPSHOT = snap;
const listeners = new Set<() => void>();
let settingsLoaded = false;

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function set(patch: Partial<ShogiSnapshot>): void {
  const before = snap.notice;
  snap = { ...snap, ...patch };
  // お知らせは 4 秒で消す（行を取り続けない。ドリキン 2026-10-21「もっと詰め込む」）。
  if (snap.notice && snap.notice !== before && typeof window !== "undefined") {
    if (noticeTimer) clearTimeout(noticeTimer);
    const shown = snap.notice;
    noticeTimer = setTimeout(() => {
      if (snap.notice === shown) set({ notice: null });
    }, 4000);
  }
  for (const l of listeners) l();
}

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  if (!settingsLoaded && typeof window !== "undefined") {
    settingsLoaded = true;
    queueMicrotask(() => set({ settings: loadSettings() }));
  }
  return () => listeners.delete(l);
}
export const getSnapshot = (): ShogiSnapshot => snap;
export const getServerSnapshot = (): ShogiSnapshot => SERVER_SNAPSHOT;

function skewOf(serverNow: string | null | undefined): number {
  const t = serverNow ? Date.parse(serverNow) : NaN;
  return Number.isFinite(t) ? t - Date.now() : snap.skew;
}

function upsert(list: ShogiGameDto[], g: ShogiGameDto): ShogiGameDto[] {
  const i = list.findIndex((x) => x.id === g.id);
  if (i < 0) return [g, ...list];
  // 古い配信で新しい状態を戻さない（手数で比べる）。
  if (list[i].ply > g.ply && list[i].status === g.status) return list;
  const next = list.slice();
  next[i] = g;
  return next;
}

type ApiBody = {
  game?: ShogiGameDto;
  games?: ShogiGameDto[];
  me?: { user_id?: string; self_play?: boolean };
  error?: string;
  code?: string;
} | null;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: ApiBody }> {
  const r = await fetch(`/api/shogi/${path}`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  let body: ApiBody = null;
  try {
    body = (await r.json()) as ApiBody;
  } catch {
    /* not json */
  }
  return { status: r.status, body };
}

export async function loadShogi(): Promise<void> {
  try {
    const r = await api("games");
    if (r.status === 404 || r.status === 401) {
      set({ status: "disabled" });
      return;
    }
    if (r.status !== 200) return;
    const games = (r.body?.games ?? []) as ShogiGameDto[];
    set({ status: "enabled", me: r.body?.me?.user_id ?? null, selfPlay: r.body?.me?.self_play === true, games, skew: skewOf(games[0]?.server_now) });
    if (snap.selectedId) void loadDetail(snap.selectedId);
  } catch {
    /* offline: keep what we have */
  }
}

/** SSE が再接続したとき（取りこぼした配信を取り直す）。 */
export function reloadShogi(): void {
  if (snap.status === "enabled") void loadShogi();
}

async function loadDetail(id: number): Promise<void> {
  const r = await api(`games/${id}`);
  if (r.status !== 200 || !r.body?.game) {
    if (snap.selectedId === id) set({ detail: null, notice: "対局が見つかりません" });
    return;
  }
  const d = r.body.game as ShogiGameDetailDto;
  if (snap.selectedId !== id) return;
  set({ detail: d, games: upsert(snap.games, d), skew: skewOf(d.server_now) });
}

/** 配信（`event: shogi`）を反映する。 */
export function applyShogiEvent(ev: { type?: string; action?: string; game?: ShogiGameDto }): void {
  const g = ev?.game;
  if (!g || typeof g.id !== "number") return;
  const patch: Partial<ShogiSnapshot> = { games: upsert(snap.games, g), skew: skewOf(g.server_now) };
  if (ev.action === "offer" && g.creator) {
    patch.notice = `${g.creator.name} さんから対局の申し込みが届きました（${g.mode === "blitz" ? "⚡速い" : "🐢ゆっくり"}）`;
  }
  // 自分の申し込みが受けられた（自分が対局者の対局が始まった）: ロビーにいればその盤を開く。
  const before = snap.games.find((x) => x.id === g.id);
  if (g.status === "active" && before && before.status !== "active" && myColorIn(g, snap.me) && !snap.selectedId) {
    patch.notice = "対局が始まりました";
    patch.selectedId = g.id;
    set(patch);
    void loadDetail(g.id);
    return;
  }
  const d = snap.detail;
  if (d && d.id === g.id) {
    if (g.ply === d.ply + 1 && g.last_move) {
      // 1 手進んだだけ: 指し手の一覧に足す（全体を取り直さない）。
      const mv: ShogiMoveDto = { ply: g.ply, usi: g.last_move.usi, label: g.last_move.label, sfen: g.sfen, spent_ms: 0, at: g.server_now };
      patch.detail = { ...d, ...g, moves: [...d.moves, mv] };
    } else if (g.ply === d.ply) {
      patch.detail = { ...d, ...g };
    } else {
      void loadDetail(g.id);
    }
  }
  set(patch);
}

export function setShogiOpen(open: boolean): void {
  set({ open, notice: open ? snap.notice : null });
  if (open && snap.status === "enabled") void loadShogi();
}

export function selectGame(id: number | null): void {
  set({ selectedId: id, detail: id && snap.detail?.id === id ? snap.detail : null });
  if (id) void loadDetail(id);
}

/** 盤で再生のリンク（#/shogi/{id}）やチャットのカードから開く。 */
export function openShogiGame(id: number): void {
  set({ open: true });
  selectGame(id);
}

export function clearShogiNotice(): void {
  set({ notice: null });
}

export function setShogiSettings(patch: Partial<ShogiSettings>): void {
  const settings = { ...snap.settings, ...patch };
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* private mode: keep it for this tab */
  }
  set({ settings });
}

async function act(path: string, body?: unknown): Promise<{ status: number; body: ApiBody } | null> {
  if (snap.busy) return null;
  set({ busy: true, notice: null });
  try {
    const r = await api(path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
    const g = r.body?.game as ShogiGameDto | undefined;
    if (g) applyShogiEvent({ action: "state", game: g });
    if (r.status >= 400) set({ notice: r.body?.error ?? "うまくいきませんでした" });
    return r;
  } catch {
    set({ notice: "通信できませんでした" });
    return null;
  } finally {
    set({ busy: false });
  }
}

export async function createShogiGame(
  mode: "blitz" | "slow",
  inviteeUserId?: string | null,
  rematchOf?: number,
  opponent?: "beagle"
): Promise<void> {
  const r = await act("games", {
    mode,
    ...(inviteeUserId ? { invitee_user_id: inviteeUserId } : {}),
    ...(rematchOf ? { rematch_of: rematchOf } : {}),
    ...(opponent ? { opponent } : {}),
  });
  const g = r?.body?.game as ShogiGameDto | undefined;
  if (r && r.status === 201 && g) {
    if (g.status === "active") {
      // ビーグル戦: すぐ始まるので盤を開く
      set({ notice: "ビーグルとの対局が始まりました（先後は振り駒）" });
      selectGame(g.id);
      return;
    }
    set({ notice: g.status === "offered" ? `${g.invitee?.name ?? "相手"} さんに申し込みました` : "募集しました（15 分）" });
  }
}

/** ビーグルと対局（練習）。申し込み・受諾なしですぐ始まる。 */
export const startBeagleGame = (mode: "blitz" | "slow", rematchOf?: number) => createShogiGame(mode, null, rematchOf, "beagle");

export async function acceptShogiGame(id: number): Promise<void> {
  const r = await act(`games/${id}/accept`);
  if (r?.status === 200) selectGame(id);
}
export const declineShogiGame = (id: number) => act(`games/${id}/decline`);
export const cancelShogiGame = (id: number) => act(`games/${id}/cancel`);
export const resignShogiGame = (id: number) => act(`games/${id}/resign`);

function newClientMoveId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** 指す。手数が合わない（409）ときは最新の状態に戻す（配信と同じ扱い）。 */
export async function playShogiMove(id: number, usi: string, expectedPly: number): Promise<void> {
  const clientMoveId = newClientMoveId();
  const send = () =>
    api(`games/${id}/move`, { method: "POST", body: JSON.stringify({ usi, expected_ply: expectedPly, client_move_id: clientMoveId }) });
  let r: { status: number; body: ApiBody } | null = null;
  try {
    r = await send();
  } catch {
    // 返事が届かなかった: 同じ client_move_id で 1 度だけ送り直す（二重には指されない）。
    try {
      r = await send();
    } catch {
      set({ notice: "通信できませんでした。もう一度指してください" });
      void loadDetail(id);
      return;
    }
  }
  const g = r.body?.game as ShogiGameDto | undefined;
  if (g) applyShogiEvent({ action: "state", game: g });
  if (r.status >= 400) {
    set({ notice: r.body?.error ?? "その手は指せませんでした" });
    void loadDetail(id);
  }
}

/** 観戦中の合図（30 秒ごと）。 */
export function watchShogiGame(id: number): void {
  void api(`games/${id}/watch`, { method: "POST", body: "{}" }).catch(() => {});
}

// ─────────────────────────── 表示の手伝い（純関数）

export function myColorIn(g: Pick<ShogiGameDto, "black" | "white"> & { turn?: Side }, me: string | null): Side | null {
  if (!me) return null;
  // 自分との対局（テスト用）: 手番の側を指す。
  if (g.black?.user_id === me && g.white?.user_id === me) return g.turn ?? "black";
  if (g.black?.user_id === me) return "black";
  if (g.white?.user_id === me) return "white";
  return null;
}

/** 手元の時刻での残り（ms）。秒読みに入っていれば byoyomi に残りが入る。 */
export function clockNow(g: ShogiGameDto, skew: number, now = Date.now()): { black: number; white: number; byoyomi: number | null } | null {
  if (!g.clocks) return null;
  let black = g.clocks.black_ms;
  let white = g.clocks.white_ms;
  let byoyomi: number | null = null;
  if (g.status === "active" && g.turn_started_at && g.ply >= 2) {
    const elapsed = Math.max(0, now + skew - Date.parse(g.turn_started_at) - 1000);
    const main = g.turn === "black" ? black : white;
    const left = main - elapsed;
    if (left >= 0) {
      if (g.turn === "black") black = left;
      else white = left;
    } else {
      if (g.turn === "black") black = 0;
      else white = 0;
      byoyomi = Math.max(0, g.clocks.byoyomi_ms + left);
    }
  }
  return { black, white, byoyomi };
}

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
