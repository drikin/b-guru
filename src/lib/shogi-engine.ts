/* ☗ ビーグルの将棋の頭（初心者の練習相手）。純関数だけ・import なし（worker_threads の中でも動く）。
 *
 * 探索の間だけ使う軽い独自の合法手生成（盤の配列）。指す手は呼び出し側が必ず tsshogi（shogi-rules.ts）で
 * 合法か確かめてから指す（docs/shogi-spec.md「ビーグル戦」）。
 *
 *   評価: 駒の価値（歩1・香3・桂4・銀5・金6・角8・飛10、成駒は加点、持ち駒は少し高め）
 *         ＋玉の周りの守り（金銀）・玉の位置・相手玉の近くの駒（少し）
 *   探索: 反復深化のアルファベータ（最大 3 手）＋取り合いの静止探索（王手されていれば全部の逃げ方）
 *         並べ替え: 前回の最善手 → 取る手（MVV-LVA）→ 成る手 → 王手
 *         1 手詰めは先に必ず調べる。根の手には小さな乱数を足し、同点の手が毎回同じにならないようにする。
 *         時間の上限を超えたら、最後に読み切った深さの最善手を返す。
 *   千日手・入玉は考えない（初心者向けの割り切り）。 */

// 駒: 歩1 香2 桂3 銀4 金5 角6 飛7 玉8、成り = +8（と9 成香10 成桂11 成銀12 馬14 龍15）。先手は正、後手は負。
const P = 1, L = 2, N = 3, S = 4, G = 5, B = 6, R = 7, K = 8;
const PROMO = 8;
const MATE = 100000;
const INF = 1_000_000;
const MAX_PLY = 64;
const MOVE_BUF = 700;

const VALUE: number[] = [0, 100, 300, 400, 500, 600, 800, 1000, 0, 550, 550, 550, 580, 0, 1050, 1250];
/** 持ち駒は打てるぶん少し高め。 */
const HAND_VALUE: number[] = [0, 110, 320, 420, 540, 640, 880, 1100];

type Dir = [number, number];
const ORTH: Dir[] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
const DIAG: Dir[] = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
const GOLD_STEPS: Dir[] = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, 0]];
const ALL8: Dir[] = [...ORTH, ...DIAG];

/** 先手から見た 1 マスの動き（steps）と走り（slides）。後手は dr を反転する。 */
const STEPS: Dir[][] = [];
const SLIDES: Dir[][] = [];
for (let code = 0; code < 16; code++) {
  STEPS[code] = [];
  SLIDES[code] = [];
}
STEPS[P] = [[-1, 0]];
SLIDES[L] = [[-1, 0]];
STEPS[S] = [[-1, -1], [-1, 0], [-1, 1], [1, -1], [1, 1]];
for (const c of [G, P + PROMO, L + PROMO, N + PROMO, S + PROMO]) STEPS[c] = GOLD_STEPS;
SLIDES[B] = DIAG;
SLIDES[R] = ORTH;
STEPS[K] = ALL8;
SLIDES[B + PROMO] = DIAG;
STEPS[B + PROMO] = ORTH;
SLIDES[R + PROMO] = ORTH;
STEPS[R + PROMO] = DIAG;

/** 先手から見て、駒 code が (dr, dc) に 1 マスで利くか（走り駒の 1 マス目を含む）。 */
const STEP_ATTACK: boolean[][] = [];
/** 先手から見て、駒 code が (dr, dc) の方向に走って利くか。 */
const SLIDE_ATTACK: boolean[][] = [];
const dirKey = (dr: number, dc: number) => (dr + 1) * 3 + (dc + 1);
for (let code = 0; code < 16; code++) {
  STEP_ATTACK[code] = new Array(9).fill(false);
  SLIDE_ATTACK[code] = new Array(9).fill(false);
  for (const [dr, dc] of STEPS[code]) STEP_ATTACK[code][dirKey(dr, dc)] = true;
  for (const [dr, dc] of SLIDES[code]) {
    STEP_ATTACK[code][dirKey(dr, dc)] = true;
    SLIDE_ATTACK[code][dirKey(dr, dc)] = true;
  }
}

const FILES = "987654321";
const RANKS = "abcdefghi";
const SFEN_PIECE: Record<string, number> = { p: P, l: L, n: N, s: S, g: G, b: B, r: R, k: K };
const USI_PIECE = ["", "P", "L", "N", "S", "G", "B", "R"];

/** 手の整数: from（0..80 = 盤、81+種類 = 打つ）| to << 7 | 成り << 14。 */
const mFrom = (m: number) => m & 127;
const mTo = (m: number) => (m >> 7) & 127;
const mPromo = (m: number) => (m >> 14) & 1;
const mk = (from: number, to: number, promo: number) => from | (to << 7) | (promo << 14);

export function sqUsi(i: number): string {
  return `${FILES[i % 9]}${RANKS[Math.floor(i / 9)]}`;
}

export function moveUsi(m: number): string {
  const from = mFrom(m);
  const to = mTo(m);
  if (from >= 81) return `${USI_PIECE[from - 81]}*${sqUsi(to)}`;
  return `${sqUsi(from)}${sqUsi(to)}${mPromo(m) ? "+" : ""}`;
}

export class Pos {
  board = new Int8Array(81);
  /** hand[side * 8 + 種類]（side 0 = 先手、1 = 後手）。 */
  hand = new Int8Array(16);
  side = 0;
  king = [-1, -1];
  private capStack = new Int8Array(MAX_PLY * 2 + 16);
  private sp = 0;

  static fromSfen(sfen: string): Pos | null {
    const parts = sfen.trim().split(/\s+/);
    if (parts.length < 3) return null;
    const pos = new Pos();
    const rows = parts[0].split("/");
    if (rows.length !== 9) return null;
    for (let r = 0; r < 9; r++) {
      let c = 0;
      let promoted = false;
      for (const ch of rows[r]) {
        if (ch === "+") {
          promoted = true;
          continue;
        }
        if (/[1-9]/.test(ch)) {
          c += Number(ch);
          continue;
        }
        const t = SFEN_PIECE[ch.toLowerCase()];
        if (!t || c > 8) return null;
        const code = promoted ? t + PROMO : t;
        const black = ch === ch.toUpperCase();
        pos.board[r * 9 + c] = black ? code : -code;
        if (t === K) pos.king[black ? 0 : 1] = r * 9 + c;
        promoted = false;
        c++;
      }
      if (c !== 9) return null;
    }
    pos.side = parts[1] === "w" ? 1 : 0;
    if (parts[2] !== "-") {
      let n = 0;
      for (const ch of parts[2]) {
        if (/[0-9]/.test(ch)) {
          n = n * 10 + Number(ch);
          continue;
        }
        const t = SFEN_PIECE[ch.toLowerCase()];
        if (!t || t === K) return null;
        pos.hand[(ch === ch.toUpperCase() ? 0 : 8) + t] += n || 1;
        n = 0;
      }
    }
    if (pos.king[0] < 0 || pos.king[1] < 0) return null;
    return pos;
  }

  make(m: number): void {
    const from = mFrom(m);
    const to = mTo(m);
    const sign = this.side === 0 ? 1 : -1;
    if (from >= 81) {
      const t = from - 81;
      this.board[to] = sign * t;
      this.hand[this.side * 8 + t]--;
      this.capStack[this.sp++] = 0;
    } else {
      const p = this.board[from];
      const cap = this.board[to];
      this.capStack[this.sp++] = cap;
      if (cap !== 0) {
        const ct = Math.abs(cap);
        this.hand[this.side * 8 + (ct > PROMO ? ct - PROMO : ct)]++;
      }
      this.board[to] = mPromo(m) ? p + sign * PROMO : p;
      this.board[from] = 0;
      if (p * sign === K) this.king[this.side] = to;
    }
    this.side ^= 1;
  }

  unmake(m: number): void {
    this.side ^= 1;
    const from = mFrom(m);
    const to = mTo(m);
    const sign = this.side === 0 ? 1 : -1;
    const cap = this.capStack[--this.sp];
    if (from >= 81) {
      this.board[to] = 0;
      this.hand[this.side * 8 + (from - 81)]++;
      return;
    }
    const p = this.board[to];
    this.board[from] = mPromo(m) ? p - sign * PROMO : p;
    this.board[to] = cap;
    if (cap !== 0) {
      const ct = Math.abs(cap);
      this.hand[this.side * 8 + (ct > PROMO ? ct - PROMO : ct)]--;
    }
    if (p * sign === K) this.king[this.side] = from;
  }

  /** side の駒が升 sq に利いているか。 */
  attacked(sq: number, side: number): boolean {
    const r0 = Math.floor(sq / 9);
    const c0 = sq % 9;
    const sign = side === 0 ? 1 : -1;
    // 8 方向: 隣の駒の 1 マスの利き、その先の走り駒
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        let r = r0 + dr;
        let c = c0 + dc;
        let dist = 1;
        while (r >= 0 && r < 9 && c >= 0 && c < 9) {
          const p = this.board[r * 9 + c];
          if (p !== 0) {
            if (p * sign > 0) {
              const code = p * sign;
              // 駒から升へ向かう方向（先手の向きに直す）
              const mdr = -dr * sign;
              const mdc = -dc;
              if (dist === 1 ? STEP_ATTACK[code][dirKey(mdr, mdc)] : SLIDE_ATTACK[code][dirKey(mdr, mdc)]) return true;
            }
            break;
          }
          r += dr;
          c += dc;
          dist++;
        }
      }
    }
    // 桂: 先手の桂は (r+2, c±1) から (r, c) に利く
    const kr = r0 + 2 * sign;
    if (kr >= 0 && kr < 9) {
      for (const dc of [-1, 1]) {
        const c = c0 + dc;
        if (c >= 0 && c < 9 && this.board[kr * 9 + c] === sign * N) return true;
      }
    }
    return false;
  }

  inCheck(side = this.side): boolean {
    return this.attacked(this.king[side], side ^ 1);
  }

  /** 疑似合法手（王手放置は見ない）を buf に入れて数を返す。
   *  full = false のときは、成れる歩・角・飛の不成を省く（探索用。弱くなる手だけ）。 */
  genPseudo(buf: Int32Array, capturesOnly: boolean, full: boolean): number {
    let n = 0;
    const side = this.side;
    const sign = side === 0 ? 1 : -1;
    const board = this.board;
    for (let from = 0; from < 81; from++) {
      const p = board[from];
      if (p * sign <= 0) continue;
      const code = p * sign;
      const r0 = Math.floor(from / 9);
      const c0 = from % 9;
      const add = (to: number) => {
        const tr = Math.floor(to / 9);
        const rel = side === 0 ? tr : 8 - tr; // 先手から見た段（0 = 敵陣の一番奥）
        const relFrom = side === 0 ? r0 : 8 - r0;
        const canPromo = code < K && code !== G && (rel <= 2 || relFrom <= 2);
        const mustPromo = (code === P || code === L) ? rel === 0 : code === N ? rel <= 1 : false;
        if (canPromo) {
          n = pushMove(buf, n, mk(from, to, 1));
          if (!mustPromo && (full || (code !== P && code !== B && code !== R))) n = pushMove(buf, n, mk(from, to, 0));
        } else {
          n = pushMove(buf, n, mk(from, to, 0));
        }
      };
      for (const [dr0, dc] of STEPS[code]) {
        const r = r0 + dr0 * sign;
        const c = c0 + dc;
        if (r < 0 || r > 8 || c < 0 || c > 8) continue;
        const t = board[r * 9 + c];
        if (t * sign > 0) continue;
        if (capturesOnly && t === 0) continue;
        add(r * 9 + c);
      }
      for (const [dr0, dc] of SLIDES[code]) {
        let r = r0 + dr0 * sign;
        let c = c0 + dc;
        while (r >= 0 && r < 9 && c >= 0 && c < 9) {
          const t = board[r * 9 + c];
          if (t * sign > 0) break;
          if (!capturesOnly || t !== 0) add(r * 9 + c);
          if (t !== 0) break;
          r += dr0 * sign;
          c += dc;
        }
      }
      if (code === N) {
        const r = r0 - 2 * sign;
        if (r >= 0 && r < 9) {
          for (const dc of [-1, 1]) {
            const c = c0 + dc;
            if (c < 0 || c > 8) continue;
            const t = board[r * 9 + c];
            if (t * sign > 0) continue;
            if (capturesOnly && t === 0) continue;
            add(r * 9 + c);
          }
        }
      }
    }
    if (capturesOnly) return n;
    // 打つ手
    const hb = side * 8;
    let pawnFiles = 0;
    if (this.hand[hb + P] > 0) {
      for (let i = 0; i < 81; i++) if (board[i] === sign * P) pawnFiles |= 1 << (i % 9);
    }
    for (let t = R; t >= P; t--) {
      if (this.hand[hb + t] <= 0) continue;
      for (let to = 0; to < 81; to++) {
        if (board[to] !== 0) continue;
        const rel = side === 0 ? Math.floor(to / 9) : 8 - Math.floor(to / 9);
        if ((t === P || t === L) && rel === 0) continue;
        if (t === N && rel <= 1) continue;
        if (t === P && pawnFiles & (1 << (to % 9))) continue; // 二歩
        n = pushMove(buf, n, mk(81 + t, to, 0));
      }
    }
    return n;
  }

  /** 指した直後（手番は相手）に、指した側の玉が取られないか・打ち歩詰めでないか。 */
  private legalAfterMake(m: number): boolean {
    const mover = this.side ^ 1;
    if (this.attacked(this.king[mover], this.side)) return false;
    if (mFrom(m) === 81 + P) {
      // 打ち歩詰め: 歩で玉に王手し、相手に逃げ方がない
      const to = mTo(m);
      const ahead = to + (mover === 0 ? -9 : 9);
      if (ahead === this.king[this.side] && !this.hasLegal()) return false;
    }
    return true;
  }

  isLegal(m: number): boolean {
    this.make(m);
    const ok = this.legalAfterMake(m);
    this.unmake(m);
    return ok;
  }

  /** 手番側に合法手が 1 つでもあるか。 */
  hasLegal(): boolean {
    const buf = scratchBuf();
    const n = this.genPseudo(buf, false, false);
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      this.make(m);
      // ここでは打ち歩詰めの判定はしない（再帰を避ける。歩以外の逃げ方があれば十分）
      const ok = !this.attacked(this.king[this.side ^ 1], this.side);
      this.unmake(m);
      if (ok) {
        releaseBuf();
        return true;
      }
    }
    releaseBuf();
    return false;
  }

  legalMoves(full = false): number[] {
    const buf = new Int32Array(MOVE_BUF);
    const n = this.genPseudo(buf, false, full);
    const out: number[] = [];
    for (let i = 0; i < n; i++) if (this.isLegal(buf[i])) out.push(buf[i]);
    return out;
  }

  /** 手番側から見た評価（歩 = 100）。 */
  evaluate(): number {
    let score = 0; // 先手から見た値
    const board = this.board;
    const kb = this.king[0];
    const kw = this.king[1];
    const kbr = Math.floor(kb / 9), kbc = kb % 9;
    const kwr = Math.floor(kw / 9), kwc = kw % 9;
    for (let i = 0; i < 81; i++) {
      const p = board[i];
      if (p === 0) continue;
      const code = p > 0 ? p : -p;
      const sgn = p > 0 ? 1 : -1;
      let v = VALUE[code];
      if (code !== K) {
        const r = Math.floor(i / 9), c = i % 9;
        // 自玉の守り（金・銀・成駒）
        const myR = p > 0 ? kbr : kwr, myC = p > 0 ? kbc : kwc;
        if (code === G || code === S || (code > PROMO && code < B + PROMO)) {
          const d = Math.max(Math.abs(r - myR), Math.abs(c - myC));
          if (d === 1) v += 28;
          else if (d === 2) v += 10;
        }
        // 相手玉の近くの駒（攻め）
        const opR = p > 0 ? kwr : kbr, opC = p > 0 ? kwc : kbc;
        const dd = Math.max(Math.abs(r - opR), Math.abs(c - opC));
        if (dd <= 2 && code !== P) v += 14;
        // 駒の前進（少し）: 歩・銀・成駒以外の小駒
        const adv = p > 0 ? 8 - r : r; // 自陣の奥 = 0
        if (code === P) v += adv >= 3 ? 4 : 0;
        else if (code === S) v += Math.min(adv, 5) * 3;
      } else {
        const r = Math.floor(i / 9);
        const home = p > 0 ? r : 8 - r; // 8 = 自陣の一番奥
        if (home < 6) v -= (6 - home) * 30; // 玉が上がりすぎ
      }
      score += sgn * v;
    }
    for (let t = P; t <= R; t++) score += (this.hand[t] - this.hand[8 + t]) * HAND_VALUE[t];
    return this.side === 0 ? score : -score;
  }

  /** 駒の損得だけ（手番側から見る）。投了の判断に使う。 */
  material(): number {
    let score = 0;
    for (let i = 0; i < 81; i++) {
      const p = this.board[i];
      if (p === 0) continue;
      score += (p > 0 ? 1 : -1) * VALUE[p > 0 ? p : -p];
    }
    for (let t = P; t <= R; t++) score += (this.hand[t] - this.hand[8 + t]) * VALUE[t];
    return this.side === 0 ? score : -score;
  }
}

function pushMove(buf: Int32Array, n: number, m: number): number {
  if (n < buf.length) buf[n] = m;
  return n + 1;
}

// hasLegal 用の使い回しの手の置き場（入れ子に呼ばれても壊れないよう段ごとに持つ）
const scratch: Int32Array[] = [];
let scratchDepth = 0;
function scratchBuf(): Int32Array {
  if (!scratch[scratchDepth]) scratch[scratchDepth] = new Int32Array(MOVE_BUF);
  return scratch[scratchDepth++];
}
function releaseBuf(): void {
  scratchDepth--;
}

// ───────────────────────────────── 探索

export type BeagleSearchOptions = {
  /** 考える時間の上限（ms）。 */
  timeMs: number;
  /** 読む深さの上限（既定 3）。 */
  maxDepth?: number;
  /** 根の手に足す乱数の幅（既定 18 = 歩の 0.18 枚）。0 なら毎回同じ。 */
  noise?: number;
  /** 乱数（0..1）。テストで固定できる。 */
  rand?: () => number;
  /** 静止探索の深さの上限（既定 6）。 */
  qMax?: number;
};

export type BeagleSearchResult = {
  /** 選んだ手（USI）。合法手がなければ null。 */
  usi: string | null;
  /** 手番側から見た評価（歩 = 100）。±MATE 付近は詰み。 */
  score: number;
  /** 読み切った深さ。 */
  depth: number;
  nodes: number;
  /** 1 手詰めを見つけた。 */
  mateIn1: boolean;
  /** 時間切れで途中で打ち切った。 */
  timedOut: boolean;
  ms: number;
  /** 指す前の駒の損得（手番側から見る）。 */
  material: number;
  legalCount: number;
};

export const MATE_SCORE = MATE;
/** 詰みを読んだ評価か（このくらいより大きい／小さい）。 */
export const MATE_BOUND = MATE - 1000;

class Abort extends Error {}

class Searcher {
  nodes = 0;
  private bufs: Int32Array[] = [];
  private orders: Int32Array[] = [];
  constructor(
    private pos: Pos,
    private deadline: number,
    private qMax: number
  ) {
    for (let i = 0; i < MAX_PLY; i++) {
      this.bufs.push(new Int32Array(MOVE_BUF));
      this.orders.push(new Int32Array(MOVE_BUF));
    }
  }

  private tick() {
    if ((++this.nodes & 511) === 0 && Date.now() > this.deadline) throw new Abort();
  }

  /** 並べ替えの点（大きいほど先）。 */
  orderScore(m: number, checkTest: boolean): number {
    const pos = this.pos;
    const from = mFrom(m);
    const to = mTo(m);
    let s = 0;
    const cap = pos.board[to];
    if (cap !== 0) {
      const attacker = from >= 81 ? 0 : Math.abs(pos.board[from]);
      s += 100000 + VALUE[Math.abs(cap)] * 10 - VALUE[attacker] / 10;
    }
    if (mPromo(m)) s += 50000 + VALUE[Math.abs(pos.board[from]) + PROMO] - VALUE[Math.abs(pos.board[from])];
    if (checkTest) {
      pos.make(m);
      if (pos.inCheck()) s += 30000;
      pos.unmake(m);
    }
    return s;
  }

  /** buf[0..n) を点の高い順に並べる（挿入ソート。手は多くても数百）。 */
  sort(buf: Int32Array, ord: Int32Array, n: number, checkTest: boolean, first = -1) {
    const lim = Math.min(n, MOVE_BUF);
    for (let i = 0; i < lim; i++) ord[i] = buf[i] === first ? 1 << 30 : this.orderScore(buf[i], checkTest);
    for (let i = 1; i < lim; i++) {
      const m = buf[i];
      const o = ord[i];
      let j = i - 1;
      while (j >= 0 && ord[j] < o) {
        buf[j + 1] = buf[j];
        ord[j + 1] = ord[j];
        j--;
      }
      buf[j + 1] = m;
      ord[j + 1] = o;
    }
  }

  negamax(depth: number, alpha: number, beta: number, ply: number): number {
    if (depth <= 0 || ply >= MAX_PLY - 8) return this.qsearch(alpha, beta, ply, 0);
    this.tick();
    const pos = this.pos;
    const buf = this.bufs[ply];
    const n = Math.min(pos.genPseudo(buf, false, false), MOVE_BUF);
    this.sort(buf, this.orders[ply], n, depth >= 2);
    let best = -INF;
    let legal = 0;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      pos.make(m);
      if (pos.attacked(pos.king[pos.side ^ 1], pos.side) || (mFrom(m) === 81 + P && this.pawnDropMate(m))) {
        pos.unmake(m);
        continue;
      }
      legal++;
      let s: number;
      try {
        s = -this.negamax(depth - 1, -beta, -alpha, ply + 1);
      } finally {
        pos.unmake(m);
      }
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    if (legal === 0) return -MATE + ply;
    return best;
  }

  /** 打った歩で相手玉に王手して、相手に逃げ方がないか（make の後に呼ぶ）。 */
  private pawnDropMate(m: number): boolean {
    const pos = this.pos;
    const mover = pos.side ^ 1;
    const ahead = mTo(m) + (mover === 0 ? -9 : 9);
    return ahead === pos.king[pos.side] && !pos.hasLegal();
  }

  qsearch(alpha: number, beta: number, ply: number, qd: number): number {
    this.tick();
    const pos = this.pos;
    const check = pos.inCheck();
    const buf = this.bufs[ply];
    if (check) {
      // 王手されている: 全部の逃げ方を調べる（詰みを見逃さない）。深すぎれば打ち切る。
      if (qd >= this.qMax || ply >= MAX_PLY - 2) return pos.evaluate();
      const n = Math.min(pos.genPseudo(buf, false, false), MOVE_BUF);
      this.sort(buf, this.orders[ply], n, false);
      let best = -INF;
      let legal = 0;
      for (let i = 0; i < n; i++) {
        const m = buf[i];
        pos.make(m);
        if (pos.attacked(pos.king[pos.side ^ 1], pos.side) || (mFrom(m) === 81 + P && this.pawnDropMate(m))) {
          pos.unmake(m);
          continue;
        }
        legal++;
        let s: number;
        try {
          s = -this.qsearch(-beta, -alpha, ply + 1, qd + 1);
        } finally {
          pos.unmake(m);
        }
        if (s > best) best = s;
        if (s > alpha) alpha = s;
        if (alpha >= beta) break;
      }
      return legal === 0 ? -MATE + ply : best;
    }
    const stand = pos.evaluate();
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    if (qd >= this.qMax || ply >= MAX_PLY - 2) return stand;
    const n = Math.min(pos.genPseudo(buf, true, false), MOVE_BUF);
    this.sort(buf, this.orders[ply], n, false);
    let best = stand;
    for (let i = 0; i < n; i++) {
      const m = buf[i];
      // 玉は取れない（取れるなら直前の手が反則）。取る駒の価値が小さすぎて届かない手は省く（デルタ枝刈り）。
      const capV = VALUE[Math.abs(pos.board[mTo(m)])];
      if (stand + capV + 600 < alpha && !mPromo(m)) continue;
      pos.make(m);
      if (pos.attacked(pos.king[pos.side ^ 1], pos.side)) {
        pos.unmake(m);
        continue;
      }
      let s: number;
      try {
        s = -this.qsearch(-beta, -alpha, ply + 1, qd + 1);
      } finally {
        pos.unmake(m);
      }
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    return best;
  }
}

/** ビーグルの 1 手を選ぶ。 */
export function beagleSearch(sfen: string, opts: BeagleSearchOptions): BeagleSearchResult {
  const t0 = Date.now();
  const pos = Pos.fromSfen(sfen);
  const empty = (legalCount: number, material: number): BeagleSearchResult => ({
    usi: null, score: -MATE, depth: 0, nodes: 0, mateIn1: false, timedOut: false, ms: Date.now() - t0, material, legalCount,
  });
  if (!pos) return empty(0, 0);
  const material = pos.material();
  const rand = opts.rand ?? Math.random;
  const noiseW = opts.noise ?? 18;
  const maxDepth = Math.max(1, Math.min(4, opts.maxDepth ?? 3));
  const deadline = t0 + Math.max(10, opts.timeMs);
  const moves = pos.legalMoves(false);
  if (moves.length === 0) return empty(0, material);

  // 1 手詰め（必ず指す）
  for (const m of moves) {
    pos.make(m);
    const mate = !pos.hasLegal();
    pos.unmake(m);
    if (mate) {
      return { usi: moveUsi(m), score: MATE - 1, depth: 1, nodes: moves.length, mateIn1: true, timedOut: false, ms: Date.now() - t0, material, legalCount: moves.length };
    }
  }

  const s = new Searcher(pos, deadline, opts.qMax ?? 6);
  const noise = moves.map(() => Math.floor(rand() * (noiseW + 1)));
  const rootScore = new Map<number, number>();
  // 初めの並べ替え: 取る・成る・王手
  let order = moves
    .map((m, i) => ({ m, i, o: s.orderScore(m, true) }))
    .sort((a, b) => b.o - a.o)
    .map((x) => x.i);
  let bestIdx = order[0];
  let bestScore = -INF;
  let depthDone = 0;
  let timedOut = false;
  for (let depth = 1; depth <= maxDepth; depth++) {
    let alpha = -INF;
    let iterBest = -1;
    let iterScore = -INF;
    try {
      for (const i of order) {
        const m = moves[i];
        const nz = Math.abs(alpha) >= MATE_BOUND ? 0 : noise[i];
        pos.make(m);
        let sc: number;
        try {
          sc = -s.negamax(depth - 1, -INF, -(alpha - nz), 1) + nz;
        } finally {
          pos.unmake(m);
        }
        rootScore.set(i, sc);
        if (sc > iterScore) {
          iterScore = sc;
          iterBest = i;
        }
        if (sc > alpha) alpha = sc;
      }
    } catch (e) {
      if (!(e instanceof Abort)) throw e;
      timedOut = true;
      // 途中まで: 前回の最善手（先頭）を読み終えていて、それより良い手が見つかっていれば使う
      if (iterBest >= 0 && (depthDone === 0 || iterScore > bestScore || iterBest === bestIdx)) {
        bestIdx = iterBest;
        bestScore = iterScore;
      }
      break;
    }
    bestIdx = iterBest;
    bestScore = iterScore;
    depthDone = depth;
    // 詰みを読み切ったら終わり
    if (bestScore >= MATE_BOUND) break;
    // 次の深さは今回の点の順に（最善手を先頭に）
    order = [...order].sort((a, b) => (rootScore.get(b) ?? -INF) - (rootScore.get(a) ?? -INF));
    if (Date.now() > deadline) {
      timedOut = depth < maxDepth;
      break;
    }
  }
  return {
    usi: moveUsi(moves[bestIdx]),
    score: bestScore === -INF ? 0 : bestScore,
    depth: depthDone,
    nodes: s.nodes,
    mateIn1: false,
    timedOut,
    ms: Date.now() - t0,
    material,
    legalCount: moves.length,
  };
}

/** すぐ指せる 1 手（worker が落ちた・時間切れのとき）: 1 手読み＋取り合いだけ、100ms まで。 */
export function beagleQuickMove(sfen: string): string | null {
  return beagleSearch(sfen, { timeMs: 100, maxDepth: 1, noise: 0, qMax: 4 }).usi;
}

/** この探索器の合法手（テストで tsshogi と突き合わせる。full = 不成も全部）。 */
export function engineLegalUsi(sfen: string, full = true): string[] {
  const pos = Pos.fromSfen(sfen);
  return pos ? pos.legalMoves(full).map(moveUsi) : [];
}
