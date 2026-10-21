/* 🎮 締め切りダッシュ — ゲームの計算（決定的なシミュレーション）。docs/minigame-spec.md が正。
 *
 * 端末（ブラウザの JS エンジン）とサーバ（Node の worker）で同じ種・同じ操作なら必ず同じ結果になるよう、
 *   - import なし・純関数（状態はただのオブジェクト）
 *   - 整数だけ（位置・速度は 1/256 px の固定小数点。Math.sin などの浮動小数点の関数は使わない）
 *   - 乱数は種つきの 32 bit 整数 PRNG（mulberry32、Math.imul と >>> だけ）
 *   - 60Hz の固定刻み（1 刻み = 1 tick）。描画は別（render.ts）で、ここは画面の大きさを知らない
 * ルールを変えたら ENGINE_VERSION を上げる（古い版の記録は「ルール更新のため記録できません」になる）。
 *
 * v2（2026-10-21 オーナー「スピードが上がるだけで単調なので簡単すぎる」）:
 *   - 空中でもう一度タップ = 急降下（松尾は空中の 1 回目が小ジャンプ、2 回目が急降下）。長押しの高跳びはそのまま
 *   - 跳んではいけない障害物（頭の高さのドローン・上から下がるブームマイク）、床の穴（落ちるとハート 1 つ）
 *   - 障害物は「型」（パターン）の組み合わせで出す。型ごとに、完璧な操作なら必ず避けられることをテストで確かめる
 *   - 500m ごとに区間（ステージ）が替わり、新しい要素が 1 つずつ増える（区間の切り替えでパワーアップを選ぶ）
 *
 * 操作の記録（inputs）: 数の配列。1 つの操作 = (前の操作からの刻み数) * 4 + code。
 *   code 0 = 離す、1 = 押す（ジャンプ・空中なら急降下）、2 = パワーアップの左を選ぶ、3 = 右を選ぶ。
 *   刻み t の操作は、刻み t を進める前に当てる（同じ刻みに複数あれば並び順どおり）。 */

export const ENGINE_VERSION = 2;
export const TICK_HZ = 60;
/** 1 回の上限（15 分）。正直に遊べば締め切りの壁が必ず追いつく。 */
export const MAX_TICKS = TICK_HZ * 60 * 15;
/** 記録の上限（件数）。 */
export const MAX_INPUTS = 30000;

export type Character = "drikin" | "matsuo" | "zenji";
export const CHARACTERS: Character[] = ["drikin", "matsuo", "zenji"];

export const FP = 256; // 固定小数点（1 px = 256）
export const PX_PER_M = 8; // 8 px = 1 m
export const RUNUP_TICKS = 180; // 最初の 3 秒は助走（障害物なし）
export const CHECKPOINT_M = 500; // 500m ごとに区間が替わり、パワーアップを選ぶ
export const START_HEARTS = 3;
/** 区間の数（最後の区間がずっと続く）。0 収録スタジオ / 1 秋葉原 / 2 締め切り前夜 / 3 散財ナイト / 4 機材の山 */
export const STAGE_COUNT = 5;

// 物の種類（描画・死因の名前は KIND_NAME）。10 未満が障害物。
export const K_XLR = 1;
export const K_MIC = 2;
export const K_BOX = 3;
export const K_BILL = 4;
export const K_DRONE = 5;
export const K_BOOM = 6;
export const K_PIT = 7;
export const K_SD = 10;
export const K_COFFEE = 11;
export const K_LAMP = 12;
export const K_MONEY = 13;
export const KIND_NAME: Record<number, string> = {
  [K_XLR]: "xlr",
  [K_MIC]: "micstand",
  [K_BOX]: "box",
  [K_BILL]: "bill",
  [K_DRONE]: "drone",
  [K_BOOM]: "boom",
  [K_PIT]: "pit",
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
export const E_FALL = 16384; // 穴に落ちた
export const E_DIVE = 32768; // 急降下
export const E_STAGE = 65536; // 区間が替わった

// 物理（固定小数点）
const JUMP_V = 1178; // 4.6 px/刻み
const AIR_JUMP_V = 1050; // パワーアップの二段ジャンプ
const MINI_JUMP_V = 800; // 松尾の小さいジャンプ
const DIVE_V = 1400; // 急降下 5.5 px/刻み
const G_HOLD = 64; // 押している間（上昇中）の重力 0.25
const G_FALL = 128; // 0.5
const HOLD_MAX = 20; // 長押しが効く刻み数
const BUFFER = 6; // 着地の少し前の押しを覚えておく刻み
const V0 = 512; // 最初の速さ 2 px/刻み
const V_MAX = 1100; // 約 4.3 px/刻み
const GAP0 = 56 * FP; // 締め切りの壁との距離（はじめ。画面の左端に少し見える）
const GAP_MAX = 104 * FP;
const STUMBLE = 30; // ぶつかったあとよろける刻み
const BILL_STUMBLE = 24;
const INVULN_HIT = 60;
const INVULN_RESUME = 60;
const FALL_GAP = 20 * FP; // 穴に落ちると壁がこれだけ近づく
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
  buffer: number;
  holding: number;
  holdT: number;
  airJumps: number; // この滞空で使った空中ジャンプ
  dove: number; // この滞空で急降下した
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
  stage: number; // 今の区間（0〜STAGE_COUNT-1）
  nextCp: number; // 次の区間・パワーアップの距離（m）
  choosing: number; // 1 = 選んでいる（刻みは進まない）
  options: number[]; // 選べる 2 つ（P_*）
  chosen: number[]; // 選んだもの（順に）
  nextObsX: number; // 次の型を置く位置（px）
  lastPat: number; // 直前の型（同じ型が続かないように）
  billT: number; // 次の請求書までの刻み
  objs: Obj[];
  dead: number;
  cause: string; // 死因（xlr / micstand / box / drone / boom / pit / deadline）
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
    buffer: 0,
    holding: 0,
    holdT: 0,
    airJumps: 0,
    dove: 0,
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
    stage: 0,
    nextCp: CHECKPOINT_M,
    choosing: 0,
    options: [],
    chosen: [],
    nextObsX: 0,
    lastPat: -1,
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
  const v = V0 + ((tick / 10) | 0);
  return v > V_MAX ? V_MAX : v;
}

/** 締め切りの壁の速さ。100 秒までは走る速さの 250/256（ふつうに走れば少しずつ離れる）、
 *  そのあとは 3 秒ごとに 1/256 ずつ速くなり、3 分前後で必ず追いつく。 */
export function wallSpeed(tick: number): number {
  const b = baseSpeed(tick);
  const k = tick < 6000 ? 250 : 250 + (((tick - 6000) / 180) | 0);
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

/** 世界の位置（px）がどの区間か。 */
export function zoneOf(px: number): number {
  const z = ((px / PX_PER_M / CHECKPOINT_M) | 0);
  return z >= STAGE_COUNT ? STAGE_COUNT - 1 : z;
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
    if (s.ground) {
      jump(s, JUMP_V);
      return;
    }
    // 空中: 二段ジャンプ（パワーアップ）→ 松尾の小さいジャンプ → 急降下
    const maxAir = s.pw[P_DOUBLE] + (s.ch === 1 ? 1 : 0);
    if (s.airJumps < maxAir) {
      const usePowerup = s.airJumps < s.pw[P_DOUBLE];
      s.airJumps++;
      s.vy = usePowerup ? AIR_JUMP_V : MINI_JUMP_V;
      s.holdT = HOLD_MAX; // 空中ジャンプは長押しで伸びない
      s.ev |= E_AIRJUMP;
      return;
    }
    if (!s.dove) {
      s.dove = 1;
      s.vy = s.vy < -DIVE_V ? s.vy : -DIVE_V;
      s.holdT = HOLD_MAX;
      s.ev |= E_DIVE;
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
  s.buffer = 0;
  s.holdT = 0;
  s.airJumps = 0;
  s.dove = 0;
  s.ev |= E_JUMP;
}

// ───────────────────────────── 1 刻み

/** 穴の上か（体の真ん中が穴の内側。ぶつかった直後の無敵・録音中は穴の上も走れる）。 */
function overPit(s: SimState): boolean {
  if (s.invuln > 0 || s.lamp > 0) return false;
  const c = (s.x >> 8) + 8;
  for (let i = 0; i < s.objs.length; i++) {
    const o = s.objs[i];
    if (o.live && o.k === K_PIT && c >= o.x + 2 && c < o.x + o.w - 2) return true;
  }
  return false;
}

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

  // 縦: ジャンプ・穴
  if (s.ground && overPit(s)) {
    s.ground = 0;
    s.vy = 0;
  }
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
      if (overPit(s)) {
        fall(s);
      } else {
        s.h = 0;
        s.vy = 0;
        s.ground = 1;
        s.airJumps = 0;
        s.dove = 0;
        s.ev |= E_LAND;
        if (s.buffer > 0) {
          jump(s, JUMP_V);
          s.holding = 1;
        }
      }
    }
  }
  if (s.buffer > 0) s.buffer--;

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

  // 500m ごと: 区間が替わり、パワーアップを選ぶ
  if (!s.dead && distanceM(s) >= s.nextCp) {
    s.nextCp += CHECKPOINT_M;
    if (s.stage < STAGE_COUNT - 1) {
      s.stage++;
      s.ev |= E_STAGE;
    }
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

/** 穴に落ちた: ハートが 1 つ減り、その場で這い上がる（しばらく無敵で穴の上も走れる）。 */
function fall(s: SimState): void {
  s.h = 0;
  s.vy = 0;
  s.ground = 1;
  s.airJumps = 0;
  s.dove = 0;
  s.hearts--;
  s.combo = 1;
  s.stumble = STUMBLE;
  s.invuln = INVULN_HIT;
  s.gap -= FALL_GAP;
  s.ev |= E_FALL;
  if (s.hearts <= 0 && !revive(s)) die(s, "pit");
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

// ───────────────────────────── 型（パターン）
//
// 型 = 区間（いつから出るか）・重み・長さ（刻み）・要素。要素の位置と穴の幅は「刻み」（その時の速さ × 刻み = px）。
// 要素: [種類, 位置, a, b]
//   T_XLR / T_MIC / T_BOX(a = 1 縦に 1 つ, 2 縦に 2 つ, 3 横に 2 つ)
//   T_DRONE(a = 下端の高さ px) / T_BOOM(a = 下端の高さ px) / T_PIT(a = 幅（刻み）)
//   T_SD(a = 高さ, b = 数) / T_RAIN(a = 請求書の数)

export const T_XLR = 1;
export const T_MIC = 2;
export const T_BOX = 3;
export const T_DRONE = 5;
export const T_BOOM = 6;
export const T_PIT = 7;
export const T_SD = 10;
export const T_RAIN = 20;

export type Pattern = { name: string; zone: number; w: number; len: number; els: number[][] };

export const PATTERNS: Pattern[] = [
  // 0 収録スタジオ: 低い・高い・山
  { name: "ケーブル", zone: 0, w: 3, len: 16, els: [[T_XLR, 0]] },
  { name: "段ボール", zone: 0, w: 3, len: 8, els: [[T_BOX, 0, 1]] },
  { name: "マイクスタンド", zone: 0, w: 3, len: 8, els: [[T_MIC, 0]] },
  { name: "高い山", zone: 0, w: 2, len: 8, els: [[T_BOX, 0, 2]] },
  { name: "横長の山", zone: 0, w: 2, len: 16, els: [[T_BOX, 0, 3]] },
  { name: "低い→高い", zone: 0, w: 2, len: 50, els: [[T_XLR, 0], [T_MIC, 42]] },
  { name: "山→スタンド", zone: 0, w: 2, len: 54, els: [[T_BOX, 0, 1], [T_MIC, 46]] },
  { name: "SD の列", zone: 0, w: 1, len: 44, els: [[T_SD, 0, 6, 5]] },
  // 1 秋葉原: 跳んではいけない（ドローン・ブームマイク）
  { name: "ブームマイク", zone: 1, w: 3, len: 10, els: [[T_BOOM, 0, 18], [T_SD, -6, 3, 3]] },
  { name: "低いドローン", zone: 1, w: 3, len: 10, els: [[T_DRONE, 0, 20]] },
  { name: "山→ブーム", zone: 1, w: 3, len: 36, els: [[T_BOX, 0, 1], [T_BOOM, 30, 18]] },
  { name: "ドローンの下の山", zone: 1, w: 2, len: 10, els: [[T_BOX, 0, 1], [T_DRONE, -2, 42]] },
  { name: "ケーブル→ドローン", zone: 1, w: 2, len: 46, els: [[T_XLR, 0], [T_DRONE, 38, 20]] },
  { name: "ブーム→スタンド", zone: 1, w: 2, len: 50, els: [[T_BOOM, 0, 18], [T_MIC, 40]] },
  // 2 締め切り前夜: 床の穴
  { name: "大きな穴", zone: 2, w: 3, len: 22, els: [[T_PIT, 0, 22]] },
  { name: "小さな穴", zone: 2, w: 3, len: 14, els: [[T_PIT, 0, 13]] },
  { name: "ケーブル→穴", zone: 2, w: 2, len: 62, els: [[T_XLR, 0], [T_PIT, 42, 20]] },
  { name: "穴→山", zone: 2, w: 2, len: 52, els: [[T_PIT, 0, 20], [T_BOX, 44, 1]] },
  { name: "穴→ブーム", zone: 2, w: 2, len: 46, els: [[T_PIT, 0, 18], [T_BOOM, 38, 18]] },
  { name: "ドローンの下の穴", zone: 2, w: 2, len: 16, els: [[T_PIT, 0, 14], [T_DRONE, 1, 46]] },
  // 3 散財ナイト: 請求書の雨
  { name: "請求書の雨", zone: 3, w: 3, len: 70, els: [[T_RAIN, 0, 4], [T_SD, 10, 6, 6]] },
  { name: "雨と穴", zone: 3, w: 2, len: 56, els: [[T_RAIN, 0, 2], [T_PIT, 34, 18]] },
  { name: "雨と山", zone: 3, w: 2, len: 72, els: [[T_RAIN, 0, 3], [T_BOX, 24, 1], [T_XLR, 60]] },
  // 4 機材の山: 速い組み合わせ
  { name: "低い→高い→穴", zone: 4, w: 3, len: 100, els: [[T_XLR, 0], [T_MIC, 40], [T_PIT, 80, 18]] },
  { name: "高い山→ブーム", zone: 4, w: 3, len: 44, els: [[T_BOX, 0, 2], [T_BOOM, 36, 18]] },
  { name: "ドローン→山→ドローン", zone: 4, w: 2, len: 62, els: [[T_DRONE, 0, 20], [T_BOX, 28, 1], [T_DRONE, 56, 20]] },
  { name: "穴が 2 つ", zone: 4, w: 2, len: 44, els: [[T_PIT, 0, 14], [T_PIT, 32, 14]] },
  { name: "山が 3 つ", zone: 4, w: 2, len: 74, els: [[T_BOX, 0, 1], [T_BOX, 34, 2], [T_BOX, 66, 1]] },
];

function obj(k: number, x: number, y: number, w: number, h: number, n = 0): Obj {
  return { k, x, y, w, h, n, vy: 0, fy: y * FP, live: 1 };
}

/** 刻み → px（その時の速さ）。 */
function tpx(t: number, v: number): number {
  return (t * v) >> 8;
}

/** 型を x（px）に置く（テストからも使う）。v = 置くときの速さ（1/256 px/刻み）。 */
export function placePattern(s: SimState, p: Pattern, x: number, v: number): void {
  for (const e of p.els) {
    const ex = x + tpx(e[1], v);
    switch (e[0]) {
      case T_XLR:
        s.objs.push(obj(K_XLR, ex, 0, 32, 5));
        break;
      case T_MIC:
        s.objs.push(obj(K_MIC, ex, 0, 16, 31));
        break;
      case T_BOX:
        s.objs.push(e[2] === 3 ? obj(K_BOX, ex, 0, 32, 15, 3) : obj(K_BOX, ex, 0, 16, e[2] === 2 ? 31 : 15, e[2] === 2 ? 2 : 1));
        break;
      case T_DRONE:
        s.objs.push(obj(K_DRONE, ex, e[2], 16, 8));
        break;
      case T_BOOM:
        s.objs.push(obj(K_BOOM, ex, e[2], 16, 200));
        break;
      case T_PIT:
        s.objs.push(obj(K_PIT, ex, 0, tpx(e[2], v), 0));
        break;
      case T_SD:
        for (let i = 0; i < e[3]; i++) s.objs.push(obj(K_SD, ex + i * 16, e[2], 12, 12, i));
        break;
      case T_RAIN: {
        // 請求書の雨: プレイヤーが着くころに低い所を落ちているように、高さをずらして置く
        const px = s.x >> 8;
        for (let i = 0; i < e[2]; i++) {
          const bx = ex + tpx(8 + i * 18, v);
          const b = obj(K_BILL, bx, 0, 12, 10);
          b.vy = 300 + ri(s, 80);
          const arrive = (((bx - px) * 256) / v) | 0; // 着くまでの刻み
          const at = arrive - 14 + ri(s, 34);
          let fy = at * b.vy;
          if (fy < 0) fy = 0;
          if (fy > 200 * FP) fy = 200 * FP;
          b.fy = fy;
          b.y = fy >> 8;
          b.n = ri(s, 64);
          s.objs.push(b);
        }
        break;
      }
    }
  }
}

function spawn(s: SimState): void {
  const px = s.x >> 8;
  if (s.tick > 30) {
    while (s.nextObsX < px + 448) spawnPattern(s);
  }
  // 空から降る請求書（秋葉原から。散財ナイトから多め）
  if (s.stage >= 1 && s.tick > 600) {
    s.billT--;
    if (s.billT <= 0) {
      let bx = px + 220 + ri(s, 140);
      // 落ちる所（真下）が障害物・穴のそばなら、すき間へずらす（前後に約 0.6 秒ぶん空ける）
      const m = tpx(36, baseSpeed(s.tick));
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 0; i < s.objs.length; i++) {
          const o = s.objs[i];
          if (!o.live || o.k >= K_SD || o.k === K_BILL) continue;
          if (bx + 12 + m > o.x && bx < o.x + o.w + m) bx = o.x + o.w + m;
        }
      }
      if (bx + 12 + m < s.nextObsX) {
        const b = obj(K_BILL, bx, 150, 12, 10);
        b.fy = 150 * FP;
        b.vy = 280 + ri(s, 120); // 1.1〜1.5 px/刻み
        b.n = ri(s, 64); // 揺れの位相（見た目だけ）
        s.objs.push(b);
      }
      let base = (s.stage >= 3 ? 300 : 460) + ri(s, 160);
      if (s.ch === 0) base = (base * 230) >> 8; // ドリキン: 請求書がやや多い（約 1 割）
      if (s.money > 0) base = base >> 1; // 散財中は倍
      for (let i = 0; i < s.pw[P_BILLHALF]; i++) base = base << 1; // 半分（重ねると 1/4）
      s.billT = base < 90 ? 90 : base;
    }
  }
}

function spawnPattern(s: SimState): void {
  const x = s.nextObsX;
  const zone = zoneOf(x);
  const v = baseSpeed(s.tick);
  // 型を選ぶ: その区間の新しい型は重く、前の区間の型は軽く。同じ型は続けない。
  let total = 0;
  const ws: number[] = [];
  for (let i = 0; i < PATTERNS.length; i++) {
    const p = PATTERNS[i];
    let w = 0;
    if (p.zone <= zone && i !== s.lastPat) w = p.zone === zone ? p.w * 3 : p.w;
    ws.push(w);
    total += w;
  }
  let pick = ri(s, total);
  let idx = 0;
  while (idx < ws.length - 1 && pick >= ws[idx]) {
    pick -= ws[idx];
    idx++;
  }
  const p = PATTERNS[idx];
  s.lastPat = idx;
  placePattern(s, p, x, v);
  // 型と型の間（刻み）: 区間が進むほど詰まる
  const gapT = 40 + ri(s, 50 - zone * 9) + (zone === 0 ? 28 : 0);
  // 間にまれにアイテム（空中）
  const it = ri(s, 100);
  const ix = x + tpx(p.len + (gapT >> 1), v);
  if (it < 5) s.objs.push(obj(K_COFFEE, ix, 14, 12, 12));
  else if (it < 8) s.objs.push(obj(K_LAMP, ix, 18, 12, 12));
  else if (it < 12) s.objs.push(obj(K_MONEY, ix, 22, 12, 12));
  s.nextObsX = x + tpx(p.len + gapT, v) + 16;
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
        o.x += ddx > 3 ? 3 + (playerSpeed(s) >> 8) : ddx < -3 ? -3 : ddx;
        o.y += ddy > 2 ? 2 : ddy < -2 ? -2 : ddy;
        if (o.y < 0) o.y = 0;
      }
    }
    s.objs[keep++] = o;
  }
  s.objs.length = keep;
}

/** 絵の余白を除いた当たり（見た目より少し小さく = 理不尽に感じない）。 */
function hitBoxOf(o: Obj): { x: number; w: number; y: number; h: number } {
  if (o.k === K_XLR) return { x: o.x + 6, w: 20, y: 0, h: 4 };
  if (o.k === K_MIC) return { x: o.x + 5, w: 7, y: 0, h: 31 };
  if (o.k === K_BOX) return { x: o.x + 1, w: o.w - 2, y: 0, h: o.h };
  if (o.k === K_BILL) return o.y > 0 ? { x: o.x, w: 12, y: o.y, h: 10 } : { x: o.x + 1, w: 10, y: 0, h: 4 }; // 床に落ちたら平たい
  if (o.k === K_DRONE) return { x: o.x + 2, w: 12, y: o.y, h: 7 };
  if (o.k === K_BOOM) return { x: o.x + 5, w: 6, y: o.y, h: 200 };
  return { x: o.x, w: o.w, y: o.y, h: o.h };
}

function collide(s: SimState): void {
  const ax = (s.x >> 8) + 4;
  const ay = s.h >> 8;
  for (let i = 0; i < s.objs.length && !s.dead; i++) {
    const o = s.objs[i];
    if (!o.live || o.k === K_PIT) continue;
    if (o.k >= K_SD) {
      if (ax - 2 < o.x + o.w && o.x < ax + PLAYER_W + 2 && ay - 2 < o.y + o.h && o.y < ay + PLAYER_H + 2) {
        o.live = 0;
        pickup(s, o.k);
      }
      continue;
    }
    const hb = hitBoxOf(o);
    if (!(ax < hb.x + hb.w && hb.x < ax + PLAYER_W && ay < hb.y + hb.h && hb.y < ay + PLAYER_H)) continue;
    if (o.k === K_BILL) {
      if (s.lamp > 0 || s.invuln > 0) continue;
      o.live = 0;
      s.stumble = BILL_STUMBLE;
      s.invuln = BILL_STUMBLE + 16; // よろけている間に次の障害物で詰まない
      s.combo = 1;
      s.ev |= E_BILLHIT;
      continue;
    }
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

/** 善司: 障害物（穴・ドローンも）の手前で一瞬スロー（0.3 秒、10 秒に 1 回）。 */
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
  mix(s.stage);
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
