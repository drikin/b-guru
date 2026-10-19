/* Pixel art for the club room map — ported from the approved prototype
 * (docs/room-prototype/bguru-room.html) and adapted to the server's tile legend
 * (room-map.ts). Everything is drawn in code at 16 px per tile; the canvas is
 * scaled by whole numbers so it stays crisp. Own palette (a club room at night),
 * independent of the site theme. */
import type { Look } from "@/lib/room-logic";
import { tileOf, type RoomMapDto } from "@/lib/room-logic";

export const TILE = 16;
export const PIXEL_FONT = '"DotGothic16", "Hiragino Maru Gothic ProN", "Osaka", "MS Gothic", monospace';
const EMOJI_FONT = "'Apple Color Emoji','Segoe UI Emoji','Noto Color Emoji',sans-serif";
export const ROOM_BG = "#120e14";
export const ROOM_COLORS = {
  amber: "#f2b24c",
  voice: "#3ccf74",
  fg: "#f3e9d8",
  dim: "#9a8fa0",
  ink: "#1d1820",
  bubble: "#fffaf0",
};

type Ctx = CanvasRenderingContext2D;
const px = (c: Ctx, col: string, x: number, y: number, w = 1, h = 1) => {
  c.fillStyle = col;
  c.fillRect(x, y, w, h);
};

function floor(c: Ctx, X: number, x: number, y: number) {
  px(c, "#7a5236", x, y, TILE, TILE);
  for (let i = 0; i < 4; i++) {
    px(c, i % 2 ? "#845b3c" : "#70492f", x, y + i * 4, TILE, 3);
    px(c, "#5c3b25", x + ((X * 7 + i * 5) % 14), y + i * 4, 1, 3);
  }
}

function drawStage(c: Ctx, tiles: string[], X: number, Y: number, x: number, y: number) {
  px(c, "#5b3f7a", x, y, TILE, TILE);
  px(c, "#6a4b8c", x, y, TILE, 1);
  px(c, "#4c3366", x, y + 8, TILE, 1);
  const below = tileOf(tiles, X, Y + 1);
  if (below !== "S" && below !== "M") {
    px(c, "#2b1d3a", x, y + 13, TILE, 3);
    px(c, "#f2b24c", x + 3, y + 14, 2, 1);
    px(c, "#f2b24c", x + 11, y + 14, 2, 1);
  }
}

/** One tile at grid (X, Y), by the server's legend character. */
export function drawTile(c: Ctx, tiles: string[], X: number, Y: number): void {
  const t = tileOf(tiles, X, Y);
  const x = X * TILE;
  const y = Y * TILE;
  switch (t) {
    case "#":
      px(c, "#3b3046", x, y, TILE, TILE);
      for (let r = 0; r < 4; r++) {
        px(c, "#4a3d57", x, y + r * 4, TILE, 1);
        px(c, "#2e2538", x + ((r % 2) * 8 + 3), y + r * 4 + 1, 1, 3);
        px(c, "#2e2538", x + (((r % 2) * 8 + 11) % 16), y + r * 4 + 1, 1, 3);
      }
      break;
    case "w":
      px(c, "#3b3046", x, y, TILE, TILE);
      px(c, "#1b2a4a", x + 2, y + 3, 12, 11);
      px(c, "#26406e", x + 2, y + 3, 12, 4);
      px(c, "#f7e7a1", x + 10, y + 5, 2, 2);
      px(c, "#d7c6e0", x + 7, y + 3, 1, 11);
      px(c, "#d7c6e0", x + 2, y + 8, 12, 1);
      px(c, "#5d4c6b", x + 1, y + 14, 14, 1);
      break;
    case "D":
      px(c, "#2a1c14", x, y, TILE, TILE);
      px(c, "#5a3a22", x + 1, y, 14, TILE);
      px(c, "#f2b24c", x + (tileOf(tiles, X + 1, Y) === "D" ? 12 : 3), y + 8, 1, 2);
      break;
    case "B":
      floor(c, X, x, y);
      px(c, "#4b2f1d", x, y, TILE, TILE);
      ["#c0504d", "#4f81bd", "#9bbb59", "#f2b24c", "#8064a2", "#4bacc6"].forEach((col, i) => {
        px(c, col, x + 1 + i * 2 + (i > 2 ? 1 : 0), y + 2, 2, 5);
        px(c, col, x + 2 + ((i + 3) % 6) * 2, y + 9, 2, 5);
      });
      px(c, "#2e1c11", x, y + 7, TILE, 2);
      break;
    case "S":
      drawStage(c, tiles, X, Y, x, y);
      break;
    case "M":
      drawStage(c, tiles, X, Y, x, y);
      px(c, "#cfcfd6", x + 7, y + 5, 2, 9);
      px(c, "#55555f", x + 5, y + 14, 6, 1);
      px(c, "#2b2b33", x + 6, y + 2, 4, 4);
      px(c, "#8a8a96", x + 7, y + 3, 1, 1);
      break;
    case ",":
      floor(c, X, x, y);
      px(c, "#8c2f39", x, y, TILE, TILE);
      px(c, "#a8404a", x + 1, y + 1, TILE - 2, TILE - 2);
      if ((X + Y) % 2) px(c, "#f2b24c", x + 7, y + 7, 2, 2);
      else {
        px(c, "#d9a441", x + 3, y + 3, 1, 1);
        px(c, "#d9a441", x + 12, y + 12, 1, 1);
      }
      break;
    case "T": {
      floor(c, X, x, y);
      px(c, "#c9925b", x, y, TILE, TILE);
      if (tileOf(tiles, X, Y - 1) !== "T") px(c, "#e0ab73", x, y, TILE, 2);
      if (tileOf(tiles, X, Y + 1) !== "T") px(c, "#a4743f", x, y + 14, TILE, 2);
      const k = (X * 7 + Y * 3) % 5;
      if (k === 0) {
        px(c, "#f3e9d8", x + 4, y + 5, 7, 5);
        px(c, "#43384a", x + 5, y + 6, 5, 1);
        px(c, "#43384a", x + 5, y + 8, 4, 1);
      } else if (k === 3) {
        px(c, "#ffffff", x + 5, y + 4, 4, 5);
        px(c, "#6b3f22", x + 6, y + 5, 2, 2);
      }
      break;
    }
    case "c":
      floor(c, X, x, y);
      px(c, "#3c6e71", x + 3, y + 3, 10, 10);
      px(c, "#4f8a8d", x + 3, y + 3, 10, 2);
      px(c, "#2b5052", x + 3, y + 12, 10, 1);
      break;
    case "F":
      floor(c, X, x, y);
      px(c, "#2f5d8a", x, y + 2, TILE, 13);
      px(c, "#3f73a8", x, y + 2, TILE, 4);
      px(c, "#24496d", x, y + 13, TILE, 2);
      if (tileOf(tiles, X - 1, Y) !== "F") px(c, "#24496d", x, y + 2, 2, 13);
      if (tileOf(tiles, X + 1, Y) !== "F") px(c, "#24496d", x + 14, y + 2, 2, 13);
      break;
    case "V":
      floor(c, X, x, y);
      px(c, "#c43d3d", x + 1, y, 14, TILE);
      if (tileOf(tiles, X, Y - 1) !== "V") {
        px(c, "#2a2a33", x + 3, y + 2, 10, 12);
        ["#3ccf74", "#f2b24c", "#4bacc6", "#f3e9d8"].forEach((col, i) => px(c, col, x + 4 + (i % 2) * 5, y + 3 + Math.floor(i / 2) * 5, 3, 4));
      } else {
        px(c, "#f3e9d8", x + 3, y + 2, 6, 2);
        px(c, "#1b1b22", x + 3, y + 8, 10, 4);
        px(c, "#8e2a2a", x + 1, y + 14, 14, 2);
      }
      break;
    case "P":
      floor(c, X, x, y);
      px(c, "#9b5a34", x + 4, y + 10, 8, 6);
      px(c, "#7d4425", x + 4, y + 10, 8, 1);
      px(c, "#2f8f4e", x + 3, y + 3, 10, 8);
      px(c, "#3fb065", x + 5, y + 1, 6, 6);
      px(c, "#24703c", x + 2, y + 7, 3, 3);
      px(c, "#24703c", x + 11, y + 6, 3, 3);
      break;
    case "C":
      floor(c, X, x, y);
      px(c, "#5a3d6e", x, y + 2, TILE, 12);
      px(c, "#7a5a92", x, y + 2, TILE, 3);
      px(c, "#43305a", x, y + 13, TILE, 1);
      if (X % 2 === 0) {
        px(c, "#2b2b33", x + 4, y + 6, 8, 5);
        px(c, "#4bacc6", x + 5, y + 7, 6, 3);
        px(c, "#55555f", x + 7, y + 11, 2, 2);
      } else {
        px(c, "#f3e9d8", x + 6, y + 7, 4, 4);
        px(c, "#6b3f22", x + 7, y + 8, 2, 2);
      }
      break;
    case "s":
      floor(c, X, x, y);
      px(c, "#2b5052", x + 4, y + 9, 8, 6);
      px(c, "#3c6e71", x + 3, y + 7, 10, 3);
      break;
    case "b":
      floor(c, X, x, y);
      px(c, "#6b4a8c", x, y + 3, TILE, 12);
      px(c, "#8a67ab", x + 1, y + 5, TILE - 2, 8);
      break;
    default:
      floor(c, X, x, y);
  }
}

/** The whole static floor plan (tiles + dotted zone frames) on its own canvas. */
export function renderBase(map: RoomMapDto): HTMLCanvasElement {
  const base = document.createElement("canvas");
  base.width = map.w * TILE;
  base.height = map.h * TILE;
  const c = base.getContext("2d")!;
  for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) drawTile(c, map.tiles, x, y);
  c.strokeStyle = "rgba(60,207,116,.55)";
  c.setLineDash([3, 3]);
  c.lineWidth = 1;
  for (const z of map.zones) c.strokeRect(z.x * TILE + 0.5, z.y * TILE + 0.5, z.w * TILE - 1, z.h * TILE - 1);
  c.setLineDash([]);
  return base;
}

/** A 16×16 character: 3 facings, a 2-step walk, sitting on chairs and stools. */
export function drawPerson(c: Ctx, x: number, y: number, look: Look, dir: "up" | "down" | "side", step: number, sitting: boolean): void {
  const { skin, hair, shirt, pants } = look;
  px(c, "rgba(0,0,0,.28)", x + 3, y + 14, 10, 2);
  const lift = sitting ? 2 : 0;
  if (!sitting) {
    const a = step === 1 ? -1 : 0;
    const b = step === 2 ? -1 : 0;
    px(c, pants, x + 5, y + 12 + a, 2, 3);
    px(c, pants, x + 9, y + 12 + b, 2, 3);
    px(c, "#1e1a22", x + 5, y + 15 + a, 2, 1);
    px(c, "#1e1a22", x + 9, y + 15 + b, 2, 1);
  } else px(c, pants, x + 4, y + 12, 8, 2);
  px(c, shirt, x + 4, y + 8 + lift, 8, 5 - lift);
  px(c, "rgba(0,0,0,.18)", x + 4, y + 12, 8, 1);
  const sw = step === 1 ? 1 : step === 2 ? -1 : 0;
  if (dir !== "side") {
    px(c, skin, x + 3, y + 9 + lift + sw, 1, 3);
    px(c, skin, x + 12, y + 9 + lift - sw, 1, 3);
  } else px(c, skin, x + 7 + sw, y + 9 + lift, 2, 3);
  px(c, skin, x + 4, y + 2 + lift, 8, 7);
  px(c, hair, x + 4, y + 1 + lift, 8, 3);
  if (dir === "up") px(c, hair, x + 4, y + 1 + lift, 8, 6);
  else if (dir === "side") {
    px(c, hair, x + 4, y + 1 + lift, 4, 6);
    px(c, "#1e1a22", x + 10, y + 5 + lift, 1, 2);
  } else {
    px(c, hair, x + 4, y + 4 + lift, 1, 2);
    px(c, hair, x + 11, y + 4 + lift, 1, 2);
    px(c, "#1e1a22", x + 6, y + 5 + lift, 1, 2);
    px(c, "#1e1a22", x + 9, y + 5 + lift, 1, 2);
    px(c, "#e08a7a", x + 5, y + 7 + lift, 1, 1);
    px(c, "#e08a7a", x + 10, y + 7 + lift, 1, 1);
  }
}

/** The club beagle: tricolour, long ears, white-tipped tail. */
export function drawBeagle(c: Ctx, x: number, y: number, frame: number, flip: boolean): void {
  c.save();
  if (flip) {
    c.translate(x * 2 + 16, 0);
    c.scale(-1, 1);
  }
  px(c, "rgba(0,0,0,.25)", x + 2, y + 14, 12, 2);
  px(c, "#c97a3a", x + 3, y + 7, 9, 5);
  px(c, "#2a1f1a", x + 5, y + 7, 6, 2);
  px(c, "#f6efe4", x + 4, y + 11, 7, 1);
  const l = frame ? 1 : 0;
  [
    [3, 12],
    [5, 12 - l],
    [9, 12],
    [11, 12 - (1 - l)],
  ].forEach(([lx, ly]) => px(c, "#f6efe4", x + lx, y + ly, 1, 3));
  px(c, "#c97a3a", x + 11, y + 3, 4, 5);
  px(c, "#f6efe4", x + 13, y + 6, 3, 2);
  px(c, "#2a1f1a", x + 15, y + 6, 1, 1);
  px(c, "#2a1f1a", x + 13, y + 4, 1, 1);
  px(c, "#7a4520", x + 10, y + 4, 2, 5);
  px(c, "#c97a3a", x + 1, y + 5 + l, 1, 3);
  px(c, "#f6efe4", x + 0, y + 4 + l, 1, 1);
  c.restore();
}

/** A name tag / floor label (x is the centre when `center`). */
export function drawLabel(c: Ctx, text: string, x: number, y: number, bg: string, fg: string, center = false): void {
  c.font = `8px ${PIXEL_FONT}, ${EMOJI_FONT}`;
  c.textBaseline = "top";
  const w = Math.ceil(c.measureText(text).width) + 4;
  const lx = Math.round(center ? x - w / 2 : x);
  c.fillStyle = bg;
  c.fillRect(lx, y, w, 9);
  c.fillStyle = fg;
  c.fillText(text, lx + 2, y + 0.5);
}

/** A speech bubble whose tail points at (x, y). */
export function drawBubble(c: Ctx, text: string, x: number, y: number): void {
  c.font = `8px ${PIXEL_FONT}, ${EMOJI_FONT}`;
  c.textBaseline = "top";
  const chars = [...text];
  const rows: string[] = [];
  for (let i = 0; i < chars.length && rows.length < 4; i += 12) rows.push(chars.slice(i, i + 12).join(""));
  const w = Math.ceil(Math.max(...rows.map((r) => c.measureText(r).width))) + 8;
  const h = rows.length * 9 + 5;
  const bx = Math.round(x - w / 2);
  const by = Math.round(y - h - 4);
  c.fillStyle = ROOM_COLORS.ink;
  c.fillRect(bx - 1, by - 1, w + 2, h + 2);
  c.fillStyle = ROOM_COLORS.bubble;
  c.fillRect(bx, by, w, h);
  c.fillRect(x - 1, by + h, 3, 2);
  c.fillRect(x, by + h + 2, 1, 1);
  c.fillStyle = ROOM_COLORS.ink;
  rows.forEach((r, i) => c.fillText(r, bx + 4, by + 3 + i * 9));
}

export function drawEmoji(c: Ctx, e: string, x: number, y: number, size = 13): void {
  c.font = `${size}px ${EMOJI_FONT}`;
  c.textBaseline = "alphabetic";
  c.fillText(e, x, y);
}
