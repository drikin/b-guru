"use client";
/* チャットの上に機能を重ねる形（docs/chat-overlay-spec.md）の Web の状態（React の外。watch-client.ts と同じ形）。
 *
 *   各機能が「出ている」かは今までどおり各 store が持つ（☗ shogi.open・🎮 minigame.open・📺 watch.open・
 *   🍻 offkai.open・🏠 room.view === "room"）。ここが持つのは、どれが広がっているか（1 つ以下）と小さな窓の位置だけ。
 *   スイッチの出し入れ（toggleActivity）もここから。 */

export type ActivityId = "room" | "shogi" | "game" | "watch" | "offkai";

export interface OverlaySnapshot {
  /** 広がっている 1 つ（null = どれも小さな窓）。 */
  expanded: ActivityId | null;
  /** 小さな窓の位置（重ねる層の左上から px）。 */
  pos: Partial<Record<ActivityId, { x: number; y: number }>>;
}

const POS_KEY = "bguru.overlay.pos";

function loadPos(): OverlaySnapshot["pos"] {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(POS_KEY) : null;
    const v = raw ? (JSON.parse(raw) as OverlaySnapshot["pos"]) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

let snap: OverlaySnapshot = { expanded: null, pos: {} };
let posLoaded = false;
const SERVER_SNAPSHOT = snap;
const subs = new Set<() => void>();

function set(patch: Partial<OverlaySnapshot>): void {
  snap = { ...snap, ...patch };
  for (const l of subs) l();
}

export function subscribe(l: () => void): () => void {
  if (!posLoaded) {
    posLoaded = true;
    snap = { ...snap, pos: loadPos() };
  }
  subs.add(l);
  return () => subs.delete(l);
}
export const getSnapshot = (): OverlaySnapshot => snap;
export const getServerSnapshot = (): OverlaySnapshot => SERVER_SNAPSHOT;

export function setExpanded(id: ActivityId | null): void {
  if (snap.expanded !== id) set({ expanded: id });
}

/** 閉じた機能が広がったままなら小さく戻す（各 store の open が外で変わったとき）。 */
export function forgetExpanded(id: ActivityId): void {
  if (snap.expanded === id) set({ expanded: null });
}

export function setWindowPos(id: ActivityId, x: number, y: number): void {
  const pos = { ...snap.pos, [id]: { x: Math.round(x), y: Math.round(y) } };
  set({ pos });
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    /* 覚えられなくても動く */
  }
}
