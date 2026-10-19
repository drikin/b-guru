/* The B-guru club room (部室) map — the one definition the server, the web and the
 * apps all use (the apps fetch it from GET /api/agent/room). Tiles are single
 * characters so the whole map travels as a few short strings; the clients draw
 * every tile themselves (original pixel art, no image assets).
 *
 *   #  wall          w  window (wall)   D  door (wall, the way in)
 *   .  floor         ,  rug             s  stool (a chat seat, walkable)
 *   C  counter       B  bookshelf       T  table          c  chair (walkable)
 *   S  stage floor   M  mic stand       F  sofa           V  vending machine
 *   P  plant         b  the beagle's bed (walkable)
 *
 * Voice (see audibility below): you hear people within HEAR_RADIUS tiles, quieter
 * with distance; the meeting table is private (only people inside it hear each
 * other); whoever stands on the stage is heard by everyone in the room. */

export const ROOM_W = 32;
export const ROOM_H = 20;
/** Tiles. */
export const HEAR_RADIUS = 4;

export type RoomZoneKind = "table" | "stage";
export interface RoomZone {
  kind: RoomZoneKind;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ROOM_ZONES: RoomZone[] = [
  { kind: "table", name: "会議テーブル", x: 2, y: 10, w: 10, h: 7 },
  { kind: "stage", name: "ステージ", x: 23, y: 1, w: 8, h: 4 },
];

/** Where you appear when you come in (just inside the door). */
export const ROOM_DOOR = { x: 15, y: 18 };
/** Labels drawn on the floor. */
export const ROOM_LABELS = [{ name: "チャット席", x: 6, y: 1 }];

function build(): string[] {
  const g: string[][] = [];
  for (let y = 0; y < ROOM_H; y++) {
    g.push([]);
    for (let x = 0; x < ROOM_W; x++) g[y].push(x === 0 || y === 0 || x === ROOM_W - 1 || y === ROOM_H - 1 ? "#" : ".");
  }
  const put = (x: number, y: number, t: string) => {
    g[y][x] = t;
  };
  const rect = (x0: number, y0: number, w: number, h: number, t: string) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) put(x, y, t);
  };
  [3, 4, 9, 10, 15, 16, 21, 22].forEach((x) => put(x, 0, "w"));
  put(15, ROOM_H - 1, "D");
  put(16, ROOM_H - 1, "D");
  rect(1, 1, 4, 1, "B");
  // Chat seats: two counters with stools, where members in text view sit.
  rect(6, 2, 12, 1, "C");
  rect(6, 3, 12, 1, "s");
  rect(6, 5, 12, 1, "C");
  rect(6, 6, 12, 1, "s");
  // Stage with a mic.
  rect(23, 1, 8, 4, "S");
  put(26, 2, "M");
  // Meeting table with chairs.
  rect(4, 12, 6, 2, "T");
  for (let x = 4; x <= 9; x++) {
    put(x, 11, "c");
    put(x, 14, "c");
  }
  put(3, 12, "c");
  put(3, 13, "c");
  put(10, 12, "c");
  put(10, 13, "c");
  // Lounge.
  rect(14, 11, 7, 6, ",");
  rect(15, 17, 5, 1, "F");
  put(30, 8, "V");
  put(30, 9, "V");
  [[1, 18], [30, 18], [1, 8], [20, 1]].forEach(([x, y]) => put(x, y, "P"));
  put(26, 17, "b");
  put(27, 17, "b");
  return g.map((r) => r.join(""));
}

export const ROOM_TILES: string[] = build();

const SOLID = new Set(["#", "w", "D", "C", "B", "T", "M", "F", "V", "P"]);

export function tileAt(x: number, y: number): string {
  return ROOM_TILES[y]?.[x] ?? "#";
}

export function walkable(x: number, y: number): boolean {
  return Number.isInteger(x) && Number.isInteger(y) && !SOLID.has(tileAt(x, y));
}

export function zoneAt(x: number, y: number): RoomZone | null {
  return ROOM_ZONES.find((z) => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h) ?? null;
}

/** The chat seats, in the order they are handed out. */
export const ROOM_SEATS: { x: number; y: number }[] = (() => {
  const out: { x: number; y: number }[] = [];
  for (const y of [3, 6]) for (let x = 6; x < 18; x++) out.push({ x, y });
  return out;
})();

/** How loud `speaker` is for `listener` (0 = not heard, 1 = full). Positions in tiles.
 *  The same rule runs in every client (to set volumes) and on the server (who may
 *  hear whom, how many may talk at once). */
export function audibility(listener: { x: number; y: number }, speaker: { x: number; y: number }): number {
  const ls = zoneAt(listener.x, listener.y);
  const sp = zoneAt(speaker.x, speaker.y);
  if (sp?.kind === "stage") return 1;
  if (ls?.kind === "table" || sp?.kind === "table") return ls === sp ? 1 : 0;
  const d = Math.hypot(listener.x - speaker.x, listener.y - speaker.y);
  if (d > HEAR_RADIUS) return 0;
  return Math.max(0.15, Math.min(1, 1 - (d - 1) / HEAR_RADIUS));
}

/** Everything a client needs to draw the room and apply the voice rule. */
export function roomMapDto() {
  return {
    w: ROOM_W,
    h: ROOM_H,
    tiles: ROOM_TILES,
    zones: ROOM_ZONES,
    door: ROOM_DOOR,
    seats: ROOM_SEATS,
    labels: ROOM_LABELS,
    hear_radius: HEAR_RADIUS,
  };
}
