/* Pure logic for the web club room (ルーム) client: walking (BFS on the server's
 * tile strings), who may hear my mic, how loud each person is, the status mark
 * over a name and the look of a character. No DOM, no fetch — unit tested in
 * src/lib/__tests__/room-logic.test.ts. The voice rule itself is the server's
 * audibility() (room-map.ts), imported as is so the two can never drift. */
import { audibility } from "./room-map";

export type RoomMode = "room" | "text";

/** A member as the web API sends it (camelCase). */
export interface RoomMember {
  userId: string;
  name: string;
  avatar: string;
  x: number;
  y: number;
  mode: RoomMode;
  listening: boolean;
  mic: boolean;
  away: boolean;
}

export interface RoomZoneDto {
  kind: "table" | "stage";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomMapDto {
  w: number;
  h: number;
  tiles: string[];
  zones: RoomZoneDto[];
  door: { x: number; y: number };
  seats: { x: number; y: number }[];
  labels: { name: string; x: number; y: number }[];
  hear_radius: number;
}

export type Dir = "up" | "down" | "left" | "right";
export const DIRS: Record<Dir, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

/** Tiles you cannot stand on (see the legend in room-map.ts). */
export const SOLID_TILES = new Set(["#", "w", "D", "C", "B", "T", "M", "F", "V", "P"]);

export function tileOf(tiles: string[], x: number, y: number): string {
  return tiles[y]?.[x] ?? "#";
}

export function isWalkable(tiles: string[], x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && !SOLID_TILES.has(tileOf(tiles, x, y));
}

export function zoneOf(zones: RoomZoneDto[], x: number, y: number): RoomZoneDto | null {
  return zones.find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) ?? null;
}

/** Shortest 4-way path from `from` to `to` as a list of steps. Empty when already
 *  there, when `to` is not walkable or blocked, or when there is no way. */
export function bfsPath(
  tiles: string[],
  from: { x: number; y: number },
  to: { x: number; y: number },
  blocked: (x: number, y: number) => boolean = () => false
): Dir[] {
  if (from.x === to.x && from.y === to.y) return [];
  if (!isWalkable(tiles, to.x, to.y) || blocked(to.x, to.y)) return [];
  const key = (x: number, y: number) => y * 1000 + x;
  const prev = new Map<number, [number, number, Dir] | null>();
  prev.set(key(from.x, from.y), null);
  const q: [number, number][] = [[from.x, from.y]];
  let found = false;
  for (let i = 0; i < q.length; i++) {
    const [x, y] = q[i];
    if (x === to.x && y === to.y) {
      found = true;
      break;
    }
    for (const d of Object.keys(DIRS) as Dir[]) {
      const [dx, dy] = DIRS[d];
      const nx = x + dx;
      const ny = y + dy;
      const k = key(nx, ny);
      if (prev.has(k) || !isWalkable(tiles, nx, ny) || blocked(nx, ny)) continue;
      prev.set(k, [x, y, d]);
      q.push([nx, ny]);
    }
  }
  if (!found) return [];
  const out: Dir[] = [];
  let k = key(to.x, to.y);
  for (let p = prev.get(k); p; p = prev.get(k)) {
    out.unshift(p[2]);
    k = key(p[0], p[1]);
  }
  return out;
}

/** Where to walk when the tap lands on furniture or a person: the free walkable
 *  neighbour of `target` closest to `from` (null when there is none). */
export function nearestFreeNeighbor(
  tiles: string[],
  target: { x: number; y: number },
  from: { x: number; y: number },
  blocked: (x: number, y: number) => boolean = () => false
): { x: number; y: number } | null {
  const near = Object.values(DIRS)
    .map(([dx, dy]) => ({ x: target.x + dx, y: target.y + dy }))
    .filter((p) => (p.x === from.x && p.y === from.y) || (isWalkable(tiles, p.x, p.y) && !blocked(p.x, p.y)));
  near.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y));
  return near[0] ?? null;
}

/** How loud `them` should play for me: the server's audibility while both of us
 *  are in the room view; 0 for anyone who is not (text view, unknown). */
export function volumeFor(me: RoomMember | null | undefined, them: RoomMember | null | undefined): number {
  if (!me || !them || me.mode !== "room" || them.mode !== "room") return 0;
  return audibility(me, them);
}

/** LiveKit identity (= userId) → volume, for every member but me. */
export function volumesFor(meId: string | null, members: RoomMember[]): Map<string, number> {
  const me = members.find((m) => m.userId === meId) ?? null;
  const out = new Map<string, number>();
  for (const m of members) if (m.userId !== meId) out.set(m.userId, volumeFor(me, m));
  return out;
}

/** Who may receive my microphone track: people in the room view, listening, who
 *  would hear me where I stand (audibility(them, me) > 0). Sorted, so two results
 *  compare with sameIds(). Empty when I am not in the room view. */
export function allowedListeners(meId: string | null, members: RoomMember[]): string[] {
  const me = members.find((m) => m.userId === meId);
  if (!me || me.mode !== "room") return [];
  return members
    .filter((m) => m.userId !== meId && m.mode === "room" && m.listening && audibility(m, me) > 0)
    .map((m) => m.userId)
    .sort();
}

export function sameIds(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** The mark before a name: 💤 away (instead of the others), ⌨️ text view,
 *  👀 watching only, 🔊 talking, 🎧 listening. */
export function statusMark(m: RoomMember, speaking: boolean): string {
  if (m.away) return "💤";
  if (m.mode === "text") return "⌨️";
  if (!m.listening) return "👀";
  if (speaking) return "🔊";
  return "🎧";
}

export interface Look {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
}

const SKINS = ["#f1c7a0", "#e8b48c", "#f4cfaa", "#e2ac82", "#f6d4b5", "#c98e66", "#a8714e"];
const HAIRS = ["#3a2a20", "#6b6b6b", "#1e1a22", "#cfcfcf", "#5a3a22", "#2b2b44", "#8a4a2a", "#c46a3a", "#d9b25a"];
const SHIRTS = ["#f2b24c", "#4f81bd", "#9bbb59", "#8064a2", "#c0504d", "#4bacc6", "#f3e9d8", "#e07a9a", "#3ccf74"];
const PANTS = ["#2f3e5c", "#333344", "#3b3b46", "#2a2a33", "#3a2f2a", "#6b4a8c", "#43384a", "#4a5a3a"];

/** FNV-1a: a stable small hash of the user id. */
export function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Skin, hair, shirt and pants chosen from the user id (same id → same look). */
export function lookFor(userId: string): Look {
  const h = hashId(userId);
  return {
    skin: SKINS[h % SKINS.length],
    hair: HAIRS[(h >>> 5) % HAIRS.length],
    shirt: SHIRTS[(h >>> 10) % SHIRTS.length],
    pants: PANTS[(h >>> 15) % PANTS.length],
  };
}

/** The text over someone's head for a chat message (photo only → 📷). */
export function bubbleText(body: string | null | undefined, images = 0): string | null {
  const t = (body ?? "").replace(/\s+/g, " ").trim();
  if (!t) return images > 0 ? "📷" : null;
  const chars = [...t];
  return chars.length > 48 ? chars.slice(0, 47).join("") + "…" : t;
}

/** Banner numbers: people in the voice (room view and listening) and how many of
 *  them are talking (LiveKit speakers, by identity). */
export function voiceCounts(members: RoomMember[], speaking: ReadonlySet<string>): { inVoice: RoomMember[]; talking: number } {
  const inVoice = members.filter((m) => m.mode === "room" && m.listening);
  return { inVoice, talking: inVoice.filter((m) => speaking.has(m.userId)).length };
}
