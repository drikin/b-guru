/* 🎮 締め切りダッシュ — ゲームの計算（決定的なシミュレーション）。docs/minigame-spec.md が正。
 *
 * 端末（ブラウザの JS エンジン）とサーバ（Node の worker）で同じ種・同じ操作なら必ず同じ結果になるよう、
 *   - import なし・純関数（状態はただのオブジェクト）
 *   - 整数だけ（位置・速度は 1/256 px の固定小数点。Math.sin などの浮動小数点の関数は使わない）
 *   - 乱数は種つきの 32 bit 整数 PRNG（mulberry32、Math.imul と >>> だけ）
 *   - 60Hz の固定刻み（1 刻み = 1 tick）。描画は別（render.ts）で、ここは画面の大きさを知らない
 * ルールを変えたら ENGINE_VERSION を上げる（古い版の記録は「ルール更新のため記録できません」になる）。
 *
 * 操作の記録（inputs）: 数の配列。1 つの操作 = (前の操作からの刻み数) * 4 + code。
 *   code 0 = 離す、1 = 押す（ジャンプ）、2 = パワーアップの左を選ぶ、3 = 右を選ぶ。
 *   刻み t の操作は、刻み t を進める前に当てる（同じ刻みに複数あれば並び順どおり）。 */

export const ENGINE_VERSION = 1;
export const TICK_HZ = 60;
/** 1 回の上限（15 分）。正直に遊べば締め切りの壁が 4 分ほどで必ず追いつく。 */
export const MAX_TICKS = TICK_HZ * 60 * 15;
/** 記録の上限（件数）。 */
export const MAX_INPUTS = 30000;

export type Character = "drikin" | "matsuo" | "zenji";
export const CHARACTERS: Character[] = ["drikin", "matsuo", "zenji"];

export const FP = 256; // 固定小数点（1 px = 256）
export const PX_PER_M = 8; // 8 px = 1 m
export const RUNUP_TICKS = 180; // 最初の 3 秒は助走（障害物なし）
export const CHECKPOINT_M = 500; // 500m ごとにパワーアップを選ぶ
export const START_HEARTS = 3;

// 物の種類（描画・死因の名前は KIND_NAME）
export const K_XLR = 1;
export const K_MIC = 2;
export const K_BOX = 3;
export const K_BILL = 4;
export const K_SD = 10;
export const K_COFFEE = 11;
export const K_LAMP = 12;
export const K_MONEY = 13;
export const KIND_NAME: Record<number, string> = {
  [K_XLR]: "xlr",
  [K_MIC]: "micstand",
  [K_BOX]: "box",
  [K_BILL]: "bill",
  [K_SD]: "sdcard",
  [K_COFFEE]: "coffee",
  [K_LAMP]: "reclamp",
  [K_MONEY]: "money",
};

// パワーアップ（500m ごとに 2 つから 1 つ）
export const P_DOUBLE = 0; // 二段ジャンプ（空中でもう 1 回）
export const P_BILLHALF = 1; // 請求書が半分
export const P_REVIVE = 2; // 1 回だけ復活
export const P_MAGNET = 3; // SD カードを吸い寄せる
export const POWERUP_MAX = [2, 2, 3, 2];

// 1 刻みに起きたこと（効果音・振動の合図。描画側が読む）
export const E_JUMP = 1;
export const E_SD = 2;
export const E_COFFEE = 4;
export const E_LAMP = 8;
export const E_MONEY = 16;
export const E_HIT = 32;
export const E_BILLHIT = 64;
export const E_CHOOSE = 128; // パワーアップを選ぶ画面になった
export const E_POWERUP = 256; // 選んだ
export const E_DEAD = 512;
export const E_REVIVE = 1024;
export const E_SLOW = 2048;
export const E_AIRJUMP = 4096;
export const E_LAND = 8192;

// 物理（固定小数点）
const JUMP_V = 1178; // 4.6 px/刻み
const AIR_JUMP_V = 1050; // パワーアップの二段ジャンプ
const MINI_JUMP_V = 800; // 松尾の小さいジャンプ
const G_HOLD = 64; // 押している間（上昇中）の重力 0.25
const G_FALL = 128; // 0.5
const HOLD_MAX = 20; // 長押しが効く刻み数
const BUFFER = 6; // 着地の少し前の押しを覚えておく刻み
const V0 = 512; // 最初の速さ 2 px/刻み
const V_MAX = 1100; // 約 4.3 px/刻み（2 分ほどで届く）
const GAP0 = 56 * FP; // 締め切りの壁との距離（はじめ。画面の左端に少し見える）
const GAP_MAX = 104 * FP;
const STUMBLE = 30; // ぶつかったあとよろける刻み
const BILL_STUMBLE = 24;
const INVULN_HIT = 60;
const INVULN_RESUME = 60;
const COFFEE_T = 90;
const LAMP_T = 300;
const MONEY_T = 480;
const SLOW_T = 18; // 善司: 0.3 秒
const SLOW_CD = 600; // 10 秒に 1 回
const PLAYER_W = 8; // 当たりの幅（左端は player.x + 4）
const PLAYER_H = 13;

export type Obj = {
  k: number;
  x: number; // 世界の px（左端）
  y: number; // 地面からの高さ px（下端）
  w: number;
  h: number;
  n: number; // 箱の数・SD の並びの番号など
  vy: number; // 請求書: 落ちる速さ（1/256 px）
  fy: number; // 請求書: 高さ（1/256 px）
  live: number; // 1 = ある
};

export type SimState = {
  v: number; // ENGINE_VERSION
  seed: number;
  ch: number; // 0 drikin 1 matsuo 2 zenji
  r: number; // 乱数の状態
  tick: number;
  x: number; // プレイヤーの世界の位置（1/256 px）
  h: number; // 足の高さ（1/256 px、0 = 地面）
  vy: number;
  ground: number; // 1 = 着地
  coyote: number;
  buffer: number;
  holding: number;
  holdT: number;
  airJumps: number; // この滞空で使った空中ジャンプ
  gap: number; // 締め切りの壁との距離（1/256 px）
  hearts: number;
  stumble: number;
  invuln: number;
  coffee: number;
  lamp: number;
  money: number;
  slow: number;
  slowCd: number;
  combo: number;
  sd: number; // 拾った SD カードの数
  points: number; // SD カードの得点
  pw: number[]; // パワーアップの数 [二段, 請求書半分, 復活, 磁石]
  nextCp: number; // 次のパワーアップの距離（m）
  choosing: number; // 1 = 選んでいる（刻みは進まない）
  options: number[]; // 選べる 2 つ（P_*）
  chosen: number[]; // 選んだもの（順に）
  nextObsX: number; // 次の障害物の位置（px）
  billT: number; // 次の請求書までの刻み
  objs: Obj[];
  dead: number;
  cause: string; // 死因（xlr / micstand / box / deadline）
  ev: number; // この刻みに起きたこと（E_*）
  revived: number;
};

export type ReplayResult = {
  ok: boolean;
  error?: string;
  ticks: number;
  distance: number; // m
  sd: number;
  points: number;
  score: number;
  cause: string;
  chosen: number[];
  dead: boolean;
};

// ───────────────────────────── 乱数（mulberry32）

export function rnd(s: { r: number }): number {
  s.r = (s.r + 0x6d2b79f5) | 0;
  let t = s.r;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

function ri(s: { r: number }, n: number): number {
  return n <= 1 ? 0 : rnd(s) % n;
}

/** 文字列（日付など）から 31 bit の種を作る（FNV-1a）。 */
export function seedFromString(str: string): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) & 0x7fffffff;
}

// ───────────────────────────── 作る・速さ

export function charIndex(c: string): number {
  const i = CHARACTERS.indexOf(c as Character);
  return i < 0 ? 0 : i;
}

export function newSim(seed: number, character: Character | string): SimState {
  const s: SimState = {
    v: ENGINE_VERSION,
    seed: seed | 0,
    ch: charIndex(character),
    r: (seed | 0) ^ 0x5bd1e995,
    tick: 0,
    x: 0,
    h: 0,
    vy: 0,
    ground: 1,
    coyote: 0,
    buffer: 0,
    holding: 0,
    holdT: 0,
    airJumps: 0,
    gap: GAP0,
    hearts: START_HEARTS,
    stumble: 0,
    invuln: 0,
    coffee: 0,
    lamp: 0,
    money: 0,
    slow: 0,
    slowCd: 0,
    combo: 1,
    sd: 0,
    points: 0,
    pw: [0, 0, 0, 0],
    nextCp: CHECKPOINT_M,
    choosing: 0,
    options: [],
    chosen: [],
    nextObsX: 0,
    billT: 600,
    objs: [],
    dead: 0,
    cause: "",
    ev: 0,
    revived: 0,
  };
  rnd(s);
  // 助走の 3 秒（2 px × 180）が終わるころ、最初の障害物に届く。
  s.nextObsX = 2 * RUNUP_TICKS + 200;
  return s;
}

/** 走る速さ（1/256 px/刻み、よろけ・コーヒーの前）。 */
export function baseSpeed(tick: number): number {
  const v = V0 + ((tick / 12) | 0);
  return v > V_MAX ? V_MAX : v;
}

/** 締め切りの壁の速さ。2 分までは走る速さの 250/256（ふつうに走れば少しずつ離れる）、
 *  そのあとは 4 秒ごとに 1/256 ずつ速くなり、4 分前後で必ず追いつく。 */
export function wallSpeed(tick: number): number {
  const b = baseSpeed(tick);
  const k = tick < 7200 ? 250 : 250 + (((tick - 7200) / 240) | 0);
  return ((b * k) / 256) | 0;
}

export function playerSpeed(s: SimState): number {
  let v = baseSpeed(s.tick);
  if (s.coffee > 0) v = v + ((v * 77) >> 8); // +30%
  if (s.stumble > 0) v = (v * 128) >> 8; // 50%
  return v;
}

export function distanceM(s: SimState): number {
  return ((s.x >> 8) / PX_PER_M) | 0;
}

export function scoreOf(s: SimState): number {
  return distanceM(s) + s.points;
}

function comboCap(s: SimState): number {
  return s.ch === 0 ? 6 : 5; // ドリキン: コンボが伸びる
}

// ───────────────────────────── 操作

/** 操作を 1 つ当てる（刻みを進める前）。 */
export function simInput(s: SimState, code: number): void {
  if (s.dead) return;
  if (code === 0) {
    s.holding = 0;
    return;
  }
  if (code === 1) {
    if (s.choosing) return;
    s.holding = 1;
    if (s.ground || s.coyote > 0) {
      jump(s, JUMP_V);
      return;
    }
    // 空中: 二段ジャンプ（パワーアップ）→ 松尾の小さいジャンプ
    const maxAir = s.pw[P_DOUBLE] + (s.ch === 1 ? 1 : 0);
    if (s.airJumps < maxAir) {
      const usePowerup = s.airJumps < s.pw[P_DOUBLE];
      s.airJumps++;
      s.vy = usePowerup ? AIR_JUMP_V : MINI_JUMP_V;
      s.holdT = 0;
      s.ev |= E_AIRJUMP;
      return;
    }
    s.buffer = BUFFER;
    return;
  }
  if ((code === 2 || code === 3) && s.choosing) {
    const p = s.options[code - 2];
    if (p === undefined) return;
    s.pw[p]++;
    s.chosen.push(p);
    s.choosing = 0;
    s.options = [];
    s.invuln = s.invuln > INVULN_RESUME ? s.invuln : INVULN_RESUME;
    s.holding = 0;
    s.ev |= E_POWERUP;
  }
}

function jump(s: SimState, v: number): void {
  s.vy = v;
  s.ground = 0;
  s.coyote = 0;
  s.buffer = 0;
  s.holdT = 0;
  s.airJumps = 0;
  s.ev |= E_JUMP;
}

// ───────────────────────────── 1 刻み

/** 1 刻み進める。死んでいる・パワーアップを選んでいる間は何もしない。 */
export function simStep(s: SimState): void {
  s.ev = 0;
  if (s.dead || s.choosing) return;
  s.tick++;
  const half = s.slow > 0 ? 1 : 0; // 善司のスロー: 世界が半分の速さ
  if (s.slow > 0) s.slow--;
  if (s.slowCd > 0) s.slowCd--;

  // 横: 走る・壁
  const pv = playerSpeed(s);
  const dx = half ? pv >> 1 : pv;
  s.x += dx;
  const wv = wallSpeed(s.tick);
  s.gap += dx - (half ? wv >> 1 : wv);
  if (s.gap > GAP_MAX) s.gap = GAP_MAX;

  // 縦: ジャンプ
  if (!s.ground) {
    let g = G_FALL;
    if (s.holding && s.vy > 0 && s.holdT < HOLD_MAX) {
      g = G_HOLD;
      s.holdT++;
    }
    if (half) {
      s.h += s.vy >> 1;
      s.vy -= g >> 1;
    } else {
      s.h += s.vy;
      s.vy -= g;
    }
    if (s.h <= 0) {
      s.h = 0;
      s.vy = 0;
      s.ground = 1;
      s.airJumps = 0;
      s.ev |= E_LAND;
      if (s.buffer > 0) {
        jump(s, JUMP_V);
        s.holding = 1;
      }
    }
  }
  if (s.buffer > 0) s.buffer--;
  if (s.coyote > 0) s.coyote--;

  // 時間で減るもの
  if (s.stumble > 0) s.stumble--;
  if (s.invuln > 0) s.invuln--;
  if (s.coffee > 0) s.coffee--;
  if (s.lamp > 0) s.lamp--;
  if (s.money > 0) s.money--;

  spawn(s);
  moveObjects(s, half);
  collide(s);
  zenjiSlow(s);

  if (!s.dead && s.gap <= 0) {
    if (!revive(s)) die(s, "deadline");
  }

  // 500m ごとのパワーアップ
  if (!s.dead && distanceM(s) >= s.nextCp) {
    s.nextCp += CHECKPOINT_M;
    const avail: number[] = [];
    for (let p = 0; p < 4; p++) if (s.pw[p] < POWERUP_MAX[p]) avail.push(p);
    if (avail.length >= 2) {
      const a = ri(s, avail.length);
      let b = ri(s, avail.length - 1);
      if (b >= a) b++;
      s.options = [avail[a], avail[b]];
      s.choosing = 1;
      s.ev |= E_CHOOSE;
    } else if (avail.length === 1) {
      s.options = [avail[0]];
      s.choosing = 1;
      s.ev |= E_CHOOSE;
    }
  }
}

function die(s: SimState, cause: string): void {
  s.dead = 1;
  s.cause = cause;
  s.holding = 0;
  s.ev |= E_DEAD;
}

function revive(s: SimState): boolean {
  if (s.pw[P_REVIVE] <= 0) return false;
  s.pw[P_REVIVE]--;
  s.revived++;
  s.hearts = s.hearts > 0 ? s.hearts : 1;
  s.gap = s.gap > 64 * FP ? s.gap : 64 * FP;
  s.invuln = 120;
  s.stumble = 0;
  s.ev |= E_REVIVE;
  return true;
}

// ───────────────────────────── 出す

function obj(k: number, x: number, y: number, w: number, h: number, n = 0): Obj {
  return { k, x, y, w, h, n, vy: 0, fy: y * FP, live: 1 };
}

/** 難しさ（0〜256）。2,400m ほどで最大。 */
function difficulty(s: SimState): number {
  const d = (distanceM(s) / 10) | 0;
  return d > 256 ? 256 : d;
}

function spawn(s: SimState): void {
  const px = s.x >> 8;
  // 障害物（と、その間の SD カード・アイテム）
  if (s.tick > 30) {
    while (s.nextObsX < px + 448) spawnPattern(s);
  }
  // 空から降る請求書
  if (s.tick > 600) {
    s.billT--;
    if (s.billT <= 0) {
      // 落ちる所（真下）が障害物のそばなら、すき間へずらす（床に落ちた請求書と障害物が重ならない）。
      let bx = px + 220 + ri(s, 140);
      for (let pass = 0; pass < 3; pass++) {
        for (let i = 0; i < s.objs.length; i++) {
          const o = s.objs[i];
          if (!o.live || o.k >= K_BILL) continue;
          if (bx + 12 + 40 > o.x && bx < o.x + o.w + 40) bx = o.x + o.w + 40;
        }
      }
      if (bx + 52 < s.nextObsX) {
        const b = obj(K_BILL, bx, 150, 12, 10);
        b.fy = 150 * FP;
        b.vy = 280 + ri(s, 120); // 1.1〜1.5 px/刻み
        b.n = ri(s, 64); // 揺れの位相（見た目だけ）
        s.objs.push(b);
      }
      let base = 380 - (difficulty(s) >> 1) + ri(s, 160);
      if (s.ch === 0) base = (base * 230) >> 8; // ドリキン: 請求書がやや多い（約 1 割）
      if (s.money > 0) base = base >> 1; // 散財中は倍
      for (let i = 0; i < s.pw[P_BILLHALF]; i++) base = base << 1; // 半分（重ねると 1/4）
      s.billT = base < 90 ? 90 : base;
    }
  }
}

function spawnPattern(s: SimState): void {
  const d = difficulty(s);
  const x = s.nextObsX;
  // 空中にいる刻み（長押しで約 31）× 速さ（コーヒー込み）＋ 余裕。難しくなるほど間が詰まる。
  const minGap = ((44 * baseSpeed(s.tick)) >> 8) + 40;
  const extra = 40 + ri(s, 240 - ((d * 150) >> 8));
  const roll = ri(s, 100);
  let w = 16;
  if (roll < 30) {
    // 床をうねる XLR ケーブル（低い。軽く跳べば越せる）
    s.objs.push(obj(K_XLR, x, 0, 32, 5));
    w = 32;
    if (ri(s, 3) === 0) sdArc(s, x + 4, 22, 3);
  } else if (roll < 52) {
    // マイクスタンド（高い。長押し）
    s.objs.push(obj(K_MIC, x, 0, 16, 31));
    if (ri(s, 2) === 0) sdArc(s, x - 8, 46, 3);
  } else if (roll < 84) {
    // 段ボールの山（1 つ／縦に 2 つ／横に 2 つ。難しくなると高い山が増える）
    const r2 = ri(s, 256);
    if (r2 < 128 - (d >> 2)) {
      s.objs.push(obj(K_BOX, x, 0, 16, 15, 1));
    } else if (r2 < 200) {
      s.objs.push(obj(K_BOX, x, 0, 16, 31, 2));
    } else {
      s.objs.push(obj(K_BOX, x, 0, 32, 15, 3));
      w = 32;
    }
    if (ri(s, 3) === 0) sdLine(s, x - 4, 40, 3);
  } else {
    // 一息（SD カードの列）
    sdLine(s, x, 6, 3 + ri(s, 3));
    w = 48;
  }
  // まれにアイテム（間の空中）
  const it = ri(s, 100);
  const ix = x + w + ((minGap + extra) >> 1);
  if (it < 5) s.objs.push(obj(K_COFFEE, ix, 14, 12, 12));
  else if (it < 8) s.objs.push(obj(K_LAMP, ix, 18, 12, 12));
  else if (it < 12) s.objs.push(obj(K_MONEY, ix, 22, 12, 12));
  s.nextObsX = x + w + minGap + extra;
}

function sdLine(s: SimState, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) s.objs.push(obj(K_SD, x + i * 16, y, 12, 12, i));
}

function sdArc(s: SimState, x: number, y: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const lift = i === 1 ? 6 : 0;
    s.objs.push(obj(K_SD, x + i * 14, y + lift, 12, 12, i));
  }
}

// ───────────────────────────── 動かす・当たり

function moveObjects(s: SimState, half: number): void {
  const px = s.x >> 8;
  const magnet = s.pw[P_MAGNET];
  const radius = magnet ? 24 + magnet * 16 : 0;
  const cx = px + 8;
  const cy = (s.h >> 8) + 7;
  let keep = 0;
  for (let i = 0; i < s.objs.length; i++) {
    const o = s.objs[i];
    if (!o.live || o.x + o.w < px - 80) continue; // 後ろに流れたものは捨てる
    if (o.k === K_BILL && o.fy > 0) {
      o.fy -= half ? o.vy >> 1 : o.vy;
      if (o.fy <= 0) o.fy = 0;
      o.y = o.fy >> 8;
    }
    if (radius && o.k === K_SD) {
      const ox = o.x + 6;
      const oy = o.y + 6;
      const ddx = cx - ox;
      const ddy = cy - oy;
      const adx = ddx < 0 ? -ddx : ddx;
      const ady = ddy < 0 ? -ddy : ddy;
      if (adx + ady < radius + 16 && ddx > -radius) {
        o.x += ddx > 3 ? 3 + (pvx(s) >> 8) : ddx < -3 ? -3 : ddx;
        o.y += ddy > 2 ? 2 : ddy < -2 ? -2 : ddy;
        if (o.y < 0) o.y = 0;
      }
    }
    s.objs[keep++] = o;
  }
  s.objs.length = keep;
}

function pvx(s: SimState): number {
  return playerSpeed(s);
}

function overlap(ax: number, ay: number, aw: number, ah: number, o: Obj, inset: number): boolean {
  const ox = o.x + inset;
  const ow = o.w - inset * 2;
  const oh = o.h - (inset > 0 ? 1 : 0);
  return ax < ox + ow && ox < ax + aw && ay < o.y + oh && o.y < ay + ah;
}

function hitBoxOf(o: Obj): { x: number; w: number; h: number } {
  // 絵の余白を除いた当たり（見た目より少し小さく = 理不尽に感じない）
  if (o.k === K_XLR) return { x: o.x + 6, w: 20, h: 4 };
  if (o.k === K_MIC) return { x: o.x + 5, w: 7, h: 31 };
  if (o.k === K_BOX) return { x: o.x + 1, w: o.w - 2, h: o.h };
  if (o.k === K_BILL) return o.y > 0 ? { x: o.x, w: 12, h: 10 } : { x: o.x + 1, w: 10, h: 4 }; // 床に落ちたら平たい
  return { x: o.x, w: o.w, h: o.h };
}

function collide(s: SimState): void {
  const ax = (s.x >> 8) + 4;
  const ay = s.h >> 8;
  for (let i = 0; i < s.objs.length && !s.dead; i++) {
    const o = s.objs[i];
    if (!o.live) continue;
    if (o.k >= K_SD) {
      if (overlap(ax - 2, ay - 2, PLAYER_W + 4, PLAYER_H + 4, o, 0)) {
        o.live = 0;
        pickup(s, o.k);
      }
      continue;
    }
    if (o.k === K_BILL) {
      if (s.lamp > 0 || s.invuln > 0) continue;
      const bb = hitBoxOf(o);
      if (ax < bb.x + bb.w && bb.x < ax + PLAYER_W && ay < o.y + bb.h && o.y < ay + PLAYER_H) {
        o.live = 0;
        s.stumble = BILL_STUMBLE;
        s.invuln = BILL_STUMBLE + 16; // よろけている間に次の障害物で詰まない
        s.combo = 1;
        s.ev |= E_BILLHIT;
      }
      continue;
    }
    const hb = hitBoxOf(o);
    if (ax < hb.x + hb.w && hb.x < ax + PLAYER_W && ay < o.y + hb.h && o.y < ay + PLAYER_H) {
      if (s.lamp > 0) {
        o.live = 0; // 録音中は蹴散らす
        continue;
      }
      if (s.invuln > 0) continue;
      s.hearts--;
      s.combo = 1;
      s.stumble = STUMBLE;
      s.invuln = INVULN_HIT;
      s.ev |= E_HIT;
      if (s.hearts <= 0 && !revive(s)) die(s, KIND_NAME[o.k]);
    }
  }
}

function pickup(s: SimState, k: number): void {
  if (k === K_SD) {
    const mul = s.money > 0 ? 2 : 1;
    s.points += 5 * s.combo * mul;
    s.sd++;
    const cap = comboCap(s);
    s.combo = s.combo + 1 > cap ? cap : s.combo + 1;
    s.ev |= E_SD;
  } else if (k === K_COFFEE) {
    s.coffee = COFFEE_T;
    s.ev |= E_COFFEE;
  } else if (k === K_LAMP) {
    s.lamp = LAMP_T;
    s.ev |= E_LAMP;
  } else if (k === K_MONEY) {
    s.money = s.ch === 0 ? MONEY_T + 48 : MONEY_T; // ドリキン: 散財が少し長い
    s.ev |= E_MONEY;
  }
}

/** 善司: 障害物の手前で一瞬スロー（0.3 秒、10 秒に 1 回）。 */
function zenjiSlow(s: SimState): void {
  if (s.ch !== 2 || s.slowCd > 0 || s.dead || s.lamp > 0) return;
  const right = (s.x >> 8) + 4 + PLAYER_W;
  for (let i = 0; i < s.objs.length; i++) {
    const o = s.objs[i];
    if (!o.live || o.k >= K_SD || (o.k === K_BILL && o.y > 20)) continue;
    const gap = hitBoxOf(o).x - right;
    if (gap >= 4 && gap <= 30) {
      s.slow = SLOW_T;
      s.slowCd = SLOW_CD;
      s.ev |= E_SLOW;
      return;
    }
  }
}

// ───────────────────────────── 記録と再生

/** 操作の記録を 1 件ずつに開く（[刻み, code] の並び）。不正なら null。 */
export function unpackInputs(packed: unknown): { tick: number; code: number }[] | null {
  if (!Array.isArray(packed) || packed.length > MAX_INPUTS) return null;
  const out: { tick: number; code: number }[] = [];
  let t = 0;
  for (let i = 0; i < packed.length; i++) {
    const n = packed[i];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 0x7fffffff) return null;
    t += (n / 4) | 0;
    if (t > MAX_TICKS) return null;
    out.push({ tick: t, code: n & 3 });
  }
  return out;
}

/** 記録する側: 刻み番号つきの操作を詰めていく。 */
export class InputRecorder {
  packed: number[] = [];
  private last = 0;
  push(tick: number, code: number): void {
    const dt = tick - this.last;
    this.packed.push((dt < 0 ? 0 : dt) * 4 + (code & 3));
    this.last = tick < this.last ? this.last : tick;
  }
}

/** 種・キャラ・操作の記録から最後まで再生する（サーバの検算と、決定論のテストに使う）。 */
export function replay(seed: number, character: string, packed: unknown, maxTicks = MAX_TICKS): ReplayResult {
  const events = unpackInputs(packed);
  const s = newSim(seed, character);
  const out = (ok: boolean, error?: string): ReplayResult => ({
    ok,
    error,
    ticks: s.tick,
    distance: distanceM(s),
    sd: s.sd,
    points: s.points,
    score: scoreOf(s),
    cause: s.cause,
    chosen: s.chosen.slice(),
    dead: !!s.dead,
  });
  if (!events) return out(false, "bad_inputs");
  for (const e of events) {
    while (s.tick < e.tick && !s.dead && !s.choosing) simStep(s);
    if (s.dead) break;
    simInput(s, e.code);
  }
  while (!s.dead && !s.choosing && s.tick < maxTicks) simStep(s);
  if (s.choosing && !s.dead) return out(false, "unfinished");
  if (!s.dead) return out(false, "too_long");
  return out(true);
}

/** 状態の要約（決定論のテストで端末どうしを比べる）。 */
export function digest(s: SimState): number {
  let h = 0x811c9dc5 | 0;
  const mix = (n: number) => {
    h ^= n | 0;
    h = Math.imul(h, 0x01000193);
  };
  mix(s.tick);
  mix(s.x);
  mix(s.h);
  mix(s.vy);
  mix(s.gap);
  mix(s.hearts);
  mix(s.points);
  mix(s.r);
  mix(s.objs.length);
  for (const o of s.objs) {
    mix(o.k);
    mix(o.x);
    mix(o.y);
    mix(o.live);
  }
  return h >>> 0;
}

/** 決定論の確かめ: 再生しながら every 刻みごとの要約（digest）を集める（端末どうし・Node とブラウザで比べる）。 */
export function traceRun(seed: number, character: string, packed: unknown, every = 60): { result: ReplayResult; digests: number[] } {
  const events = unpackInputs(packed) ?? [];
  const s = newSim(seed, character);
  const digests: number[] = [];
  const stepRec = () => {
    simStep(s);
    if (s.tick % every === 0) digests.push(digest(s));
  };
  for (const e of events) {
    while (s.tick < e.tick && !s.dead && !s.choosing) stepRec();
    if (s.dead) break;
    simInput(s, e.code);
  }
  while (!s.dead && !s.choosing && s.tick < MAX_TICKS) stepRec();
  digests.push(digest(s));
  return {
    result: { ok: !!s.dead, ticks: s.tick, distance: distanceM(s), sd: s.sd, points: s.points, score: scoreOf(s), cause: s.cause, chosen: s.chosen.slice(), dead: !!s.dead },
    digests,
  };
}
