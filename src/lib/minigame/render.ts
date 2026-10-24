/* 🎮 散財ダッシュ — 描画（canvas）。sim.ts の状態を読むだけで、状態は変えない。
 *
 * 論理解像度は高さ 144・幅 256〜384（枠の横幅に合わせる）。canvas はその大きさで描き、CSS で
 * 枠の横幅いっぱいまで拡大する（image-rendering: pixelated。整数倍に限ると、幅 380 の Mac のパネルでは
 * 1 倍の高さ 144px にしかならず小さすぎた — ドリキン 2026-10-24「老眼でも見やすいサイズ」）。
 * 横に広い枠でも、sim は 448px 先まで物を出しているので画面の右端で物が湧いて見えない。 */
import { SPRITE_SET, type Sprite } from "./sprites";
import {
  CHARACTERS,
  FP,
  K_BILL,
  K_BOOM,
  K_BOX,
  K_COFFEE,
  K_DRONE,
  K_LAMP,
  K_MIC,
  K_MONEY,
  K_PIT,
  K_SD,
  K_XLR,
  zoneOf,
  type SimState,
} from "./sim";

export const VIEW_H = 144;
export const VIEW_W_MIN = 256;
export const VIEW_W_MAX = 384;
export const GROUND_Y = 128; // 床の上端
export const PLAYER_X = 56; // プレイヤーの絵の左端（画面）

const KIND_SPRITE: Record<number, string> = {
  [K_XLR]: "xlr",
  [K_MIC]: "micstand",
  [K_BOX]: "box",
  [K_BILL]: "bill",
  [K_SD]: "sdcard",
  [K_COFFEE]: "coffee",
  [K_LAMP]: "reclamp",
  [K_MONEY]: "money",
};

/** 区間ごとの空の色（上・中・下）と星の色。 */
export const STAGE_LOOK: { sky: [string, string, string]; star: string }[] = [
  { sky: ["#1d1820", "#2b1d3a", "#2b1d3a"], star: "#5b3f7a" }, // 0 収録スタジオ（室内）
  { sky: ["#120e14", "#1d1820", "#2b1d3a"], star: "#5b3f7a" }, // 1 秋葉原
  { sky: ["#0c1222", "#1b2a4a", "#1d1820"], star: "#4bacc6" }, // 2 締め切り前夜
  { sky: ["#1d0f24", "#3b1d4a", "#5b3f7a"], star: "#e86a92" }, // 3 散財ナイト
  { sky: ["#1d1410", "#3a2416", "#4b2f1d"], star: "#c98a2e" }, // 4 機材の山
];

/** k: 論理の 1 画素が端末の何画素か（整数とは限らない）。 */
export type Fit = { k: number; w: number; cssW: number; cssH: number; dpr: number };

/** 枠の横幅（CSS px）と高さの上限から、論理の横幅と拡大率を決める。横幅いっぱいに広げ、高さの上限を
 *  超えるときだけ論理の横幅を広げて（見える範囲が先へ伸びる）収める。それでも高ければ上限の高さで中央に置く。
 *  論理の横幅は 256 より狭くしない（先の見通しを減らさない。sim は見た目の幅に関係なく同じ）。 */
export function fitView(cssWidth: number, maxCssHeight: number, devicePixelRatio: number): Fit {
  const dpr = Math.min(2, Math.max(1, devicePixelRatio || 1));
  const cw = Math.max(1, cssWidth);
  const w = Math.max(VIEW_W_MIN, Math.min(VIEW_W_MAX, Math.ceil((VIEW_H * cw) / Math.max(1, maxCssHeight))));
  let scale = cw / w;
  if (VIEW_H * scale > maxCssHeight) scale = maxCssHeight / VIEW_H;
  scale = Math.max(scale, 0.5);
  return { k: scale * dpr, w, cssW: Math.floor(w * scale), cssH: Math.floor(VIEW_H * scale), dpr };
}

type Img = HTMLCanvasElement;

const cache = new Map<string, Img>();

/** 1 コマを canvas にする（パレットの索引 → 色）。 */
export function frameImage(name: string, frame?: string): Img | null {
  const sp: Sprite | undefined = SPRITE_SET[name];
  if (!sp || typeof document === "undefined") return null;
  const key = `${name}/${frame ?? ""}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const rows = (frame && sp.frames[frame]) || Object.values(sp.frames)[0];
  if (!rows) return null;
  const h = rows.length;
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const r = rows[y];
    for (let x = 0; x < r.length; x++) {
      const ch = r[x];
      if (ch === ".") continue;
      const idx = parseInt(ch, 36);
      const hex = sp.palette[idx];
      if (!hex) continue;
      const o = (y * w + x) * 4;
      img.data[o] = parseInt(hex.slice(1, 3), 16);
      img.data[o + 1] = parseInt(hex.slice(3, 5), 16);
      img.data[o + 2] = parseInt(hex.slice(5, 7), 16);
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(key, c);
  return c;
}

/** DOM に出す小さな絵（タイトルのキャラ・死因・パワーアップ）。 */
export function spriteDataUrl(name: string, frame?: string): string {
  const c = frameImage(name, frame);
  try {
    return c ? c.toDataURL() : "";
  } catch {
    return "";
  }
}

export class Renderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  w = VIEW_W_MIN;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("canvas 2d が使えません");
    this.ctx = ctx;
  }

  resize(w: number): void {
    this.w = w;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== VIEW_H) this.canvas.height = VIEW_H;
    this.ctx.imageSmoothingEnabled = false;
  }

  private img(name: string, frame: string | undefined, x: number, y: number): void {
    const im = frameImage(name, frame);
    if (im) this.ctx.drawImage(im, x | 0, y | 0);
  }

  /** 背景（区間ごとの空・小物・街・床）。camX = 世界の px（スクロール量）、zone = 区間。 */
  background(camX: number, t: number, zone = 0): void {
    const c = this.ctx;
    const W = this.w;
    const look = STAGE_LOOK[zone] ?? STAGE_LOOK[0];
    c.fillStyle = look.sky[0];
    c.fillRect(0, 0, W, VIEW_H);
    c.fillStyle = look.sky[1];
    c.fillRect(0, 40, W, 50);
    c.fillStyle = look.sky[2];
    c.fillRect(0, 80, W, 48);
    if (zone === 0) {
      // 収録スタジオ: 吸音材の壁と「ON AIR」のランプ
      const off = -((camX >> 1) % 24);
      for (let x = off; x < W; x += 24) {
        for (let y = 14; y < GROUND_Y - 8; y += 24) {
          c.fillStyle = ((x - off) / 24 + (y - 14) / 24) % 2 === 0 ? "#3d3646" : "#33283f";
          c.fillRect(x + 2, y, 20, 20);
        }
      }
      const ax = (((-(camX >> 1)) % 300) + 300) % 300;
      c.fillStyle = (t >> 5) & 1 ? "#dc4a3f" : "#8c2f39";
      c.fillRect(ax + 40, 24, 22, 7);
      c.fillStyle = "#fdf0d2";
      c.fillRect(ax + 43, 27, 16, 1);
      this.tile("floor", camX, GROUND_Y, 16);
      return;
    }
    // 星（決まった位置・ゆっくり流れる）
    for (let i = 0; i < 28; i++) {
      const sx = ((i * 97 + 13) % 400) - ((camX >> 4) % 400);
      const x = ((sx % 400) + 400) % 400;
      const y = (i * 53) % 70;
      if (x >= W) continue;
      const tw = ((t >> 4) + i) % 9 === 0;
      c.fillStyle = tw ? "#fdf0d2" : look.star;
      c.fillRect(x, y, 1, 1);
    }
    if (zone === 2) {
      // 締め切り前夜: 月
      const mx = W - 60;
      c.fillStyle = "#f7e7a1";
      c.fillRect(mx, 14, 12, 12);
      c.fillRect(mx - 2, 16, 16, 8);
      c.fillRect(mx + 2, 12, 8, 16);
      c.fillStyle = look.sky[0];
      c.fillRect(mx + 5, 13, 8, 9);
    }
    if (zone === 3) {
      // 散財ナイト: お札が舞う
      const m = frameImage("money");
      if (m) {
        c.globalAlpha = 0.22;
        for (let i = 0; i < 6; i++) {
          const x = ((((i * 71 - (camX >> 2) + (t >> 1)) % (W + 40)) + W + 40) % (W + 40)) - 20;
          const y = (i * 37 + (t >> 2)) % 56;
          c.drawImage(m, x, y);
        }
        c.globalAlpha = 1;
      }
    }
    if (zone === 4) {
      // 機材の山: 奥に積まれた段ボールの影（障害物と見間違えないよう、模様のない暗い形）
      c.fillStyle = "#2a1f1a";
      const off = -((camX >> 2) % 96);
      for (let x = off; x < W; x += 96) {
        c.fillRect(x, GROUND_Y - 58, 22, 58);
        c.fillRect(x + 22, GROUND_Y - 34, 18, 34);
        c.fillRect(x + 52, GROUND_Y - 46, 26, 46);
      }
    }
    // 遠くの街・近くの街（視差）
    if (zone !== 4) this.tile("city2", camX >> 2, GROUND_Y - 48 - 10, 64);
    if (zone === 1 || zone === 3) this.tile("city1", camX >> 1, GROUND_Y - 48, 64);
    if (zone === 1) {
      // 秋葉原: ネオンの看板
      const off = -((camX >> 1) % 64);
      for (let x = off, i = 0; x < W; x += 64, i++) {
        const on = ((t >> 4) + i) % 5 !== 0;
        c.fillStyle = on ? (i % 2 ? "#e86a92" : "#4bacc6") : "#3d3646";
        c.fillRect(x + 20, 86 + (i % 3) * 6, 3, 10);
      }
    }
    // 床
    this.tile("floor", camX, GROUND_Y, 16);
  }

  private tile(name: string, offset: number, y: number, step: number): void {
    const im = frameImage(name);
    if (!im) return;
    const start = -(((offset % step) + step) % step);
    for (let x = start; x < this.w; x += step) this.ctx.drawImage(im, x, y);
  }

  /** ゲームの 1 場面。 */
  scene(s: SimState, character: string, t: number): void {
    const px = s.x >> 8;
    const camX = px - PLAYER_X;
    this.background(camX, t, zoneOf(px));
    const c = this.ctx;
    // 床の穴（先に描く: 床を黒く抜く）
    for (const o of s.objs) {
      if (!o.live || o.k !== K_PIT) continue;
      const sx = o.x - camX;
      if (sx > this.w || sx + o.w < 0) continue;
      c.fillStyle = "#120e14";
      c.fillRect(sx, GROUND_Y, o.w, VIEW_H - GROUND_Y);
      c.fillStyle = "#c98a2e";
      c.fillRect(sx - 1, GROUND_Y, 1, VIEW_H - GROUND_Y);
      c.fillRect(sx + o.w, GROUND_Y, 1, VIEW_H - GROUND_Y);
      if (s.invuln > 0 || s.lamp > 0) {
        // 無敵の間は穴の上も走れる（板を渡した絵）
        c.fillStyle = "#7c5434";
        c.fillRect(sx, GROUND_Y, o.w, 3);
      }
    }

    for (const o of s.objs) {
      if (!o.live || o.k === K_PIT) continue;
      const sx = o.x - camX;
      if (sx > this.w + 4 || sx + Math.min(o.w, 64) < -40) continue;
      const name = KIND_SPRITE[o.k];
      if (o.k === K_XLR) {
        // 床をうねる（8px ずつ上下にずらす）
        const im = frameImage("xlr");
        if (im) {
          for (let i = 0; i < 4; i++) {
            const dy = (((s.tick >> 3) + i) & 3) === 0 ? -1 : 0;
            c.drawImage(im, i * 8, 0, 8, im.height, sx + i * 8, GROUND_Y - im.height + dy + 1, 8, im.height);
          }
        }
      } else if (o.k === K_BOX) {
        if (o.n === 2) {
          this.img("box", undefined, sx, GROUND_Y - 16);
          this.img("box", undefined, sx, GROUND_Y - 32);
        } else if (o.n === 3) {
          this.img("box", undefined, sx, GROUND_Y - 16);
          this.img("box", undefined, sx + 16, GROUND_Y - 16);
        } else this.img("box", undefined, sx, GROUND_Y - 16);
      } else if (o.k === K_DRONE) {
        const im = frameImage("drone", (t >> 2) & 1 ? "f2" : "f1");
        const bob = ((t >> 4) & 1) === 0 ? 0 : -1;
        if (im) c.drawImage(im, sx, GROUND_Y - o.y - 9 + bob);
      } else if (o.k === K_BOOM) {
        // 竿（上から）＋先のマイク
        const top = GROUND_Y - o.y - 16;
        c.fillStyle = "#55555f";
        c.fillRect(sx + 7, 0, 2, Math.max(0, top + 1));
        c.fillStyle = "#8a8a96";
        c.fillRect(sx + 7, 0, 1, Math.max(0, top + 1));
        const im = frameImage("boommic");
        if (im) c.drawImage(im, sx, top);
      } else if (o.k === K_MIC) {
        const im = frameImage("micstand");
        if (im) c.drawImage(im, sx, GROUND_Y - im.height);
      } else if (o.k === K_BILL) {
        const im = frameImage("bill");
        if (!im) continue;
        if (o.y > 0) {
          const ph = (s.tick + o.n) & 63;
          const sway = ph < 32 ? (ph >> 3) - 2 : 2 - ((ph - 32) >> 3);
          c.drawImage(im, sx - 2 + sway, GROUND_Y - o.y - 13);
        } else {
          // 床に落ちた請求書は平たく
          c.drawImage(im, 0, 0, im.width, im.height, sx - 2, GROUND_Y - 7, im.width, 8);
        }
      } else if (name) {
        const bob = o.k === K_SD ? (((s.tick >> 3) + o.n) & 3) === 0 ? -1 : 0 : ((s.tick >> 4) & 1) === 0 ? -1 : 0;
        this.img(name, undefined, sx, GROUND_Y - o.y - 12 + bob);
      }
    }

    // プレイヤー
    const name = CHARACTERS.includes(character as never) ? character : "drikin";
    const py = GROUND_Y - (s.h >> 8) - 16;
    let frame = (px >> 3) & 1 ? "run2" : "run1";
    if (s.dead || s.stumble > 0) frame = "hit";
    else if (!s.ground) frame = "jump";
    const blink = !s.dead && s.invuln > 0 && s.lamp === 0 && ((s.tick >> 2) & 1) === 1;
    if (s.coffee > 0 && !s.dead) {
      c.fillStyle = "#f2b24c";
      for (let i = 0; i < 3; i++) c.fillRect(PLAYER_X - 6 - ((s.tick * 3 + i * 5) % 10), py + 4 + i * 4, 4, 1);
    }
    if (s.lamp > 0) {
      c.fillStyle = (s.tick >> 3) & 1 ? "#dc4a3f" : "#8c2f39";
      c.fillRect(PLAYER_X - 1, py - 1, 18, 18);
    }
    if (!blink) this.img(name, frame, PLAYER_X, py);
    if (s.lamp > 0) {
      c.fillStyle = "#dc4a3f";
      c.fillRect(PLAYER_X + 6, py - 5, 3, 3);
    }
    if (s.money > 0) {
      c.fillStyle = (s.tick >> 2) & 1 ? "#f2b24c" : "#f7e7a1";
      c.fillRect(PLAYER_X + 2 + ((s.tick >> 1) % 12), py - 3, 1, 1);
    }
    if (s.slow > 0) {
      c.fillStyle = "rgba(75,172,198,0.18)";
      c.fillRect(0, 0, this.w, VIEW_H);
    }

    // 締め切りの壁（左から迫る）
    const wallX = PLAYER_X + 4 - Math.floor(s.gap / FP);
    this.wall(wallX, s.tick);
  }

  private wall(right: number, t: number): void {
    const im = frameImage("deadline");
    if (!im || right < -16) return;
    const c = this.ctx;
    for (let y = 0; y < GROUND_Y + 16; y += 16) {
      const jag = ((y >> 4) + (t >> 3)) & 1 ? 4 : 0;
      for (let x = right - 16 - jag; x > -16; x -= 16) c.drawImage(im, x, y);
    }
    c.fillStyle = "#fdf0d2";
    c.fillRect(right - 1, 0, 1, GROUND_Y);
  }

  /** タイトル・結果の後ろ（キャラがその場で走る）。 */
  idle(character: string, t: number, dead = false): void {
    this.background(t >> 1, t, 1);
    const frame = dead ? "hit" : (t >> 3) & 1 ? "run2" : "run1";
    this.img(character, frame, PLAYER_X, GROUND_Y - 16);
    if (!dead) this.img("beagle", (t >> 3) & 1 ? "run1" : "run2", PLAYER_X - 24, GROUND_Y - 16);
    else this.img("beagle", "sit", PLAYER_X - 22, GROUND_Y - 16);
  }
}
