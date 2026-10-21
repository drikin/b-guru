/* ☗ 将棋の盤面（描くだけの部品。React も Next も使わない素の DOM）。
 *
 * Web は React の包み（components/shogi/ShogiBoard.tsx）からこのクラスを直接使い、アプリは
 * /shogi-board/index.html（bridge.ts を束ねた board.js）を WebView で開いて postMessage で話す。
 * 局面・手番・自分の色・最後の手（・合法手）を受け取り、指した手を返すだけ。API もトークンも持たない。
 *
 * 操作（docs/shogi-spec.md「盤面」）: タップ → 行き先、ドラッグでも可。動ける升に点、取れる升は
 * 枠。成れるときは行き先の上に「成｜不成」、行き所のない駒は自動で成る。持ち駒は盤の左右の
 * 駒台（相手は左に上から、自分は右に下から）で「歩×3」。名前と時計は盤の上下の細い 1 行。
 * 最後の手は升を黄色＋上の帯に「▲7六歩」。反則の升には点を出さない（合法手だけを出す）。
 * 「指す前に確認」「駒の動きヒント（点）」の設定。
 *
 * 見た目はジュークボックス（レコード）に合わせる: 盤の縁はターンテーブルの木の台の色、盤は明るいクリーム、
 * 駒は白に濃い縁取り、選択・合法手はアプリの緑（#16a34a）、持ち駒の台と帯はレコード棚のチップの色。 */
import { Color, PieceType, Position, Square } from "tsshogi";
import { labelFor, legalUsi, type Side } from "../shogi-rules";

export type BoardSettings = { confirmMove: boolean; moveHints: boolean };
export type BoardTheme = "light" | "dark" | "auto";
export type Haptic = "select" | "move" | "error";

export type BoardState = {
  sfen: string;
  /** 自分の色（観戦は null）。 */
  myColor: Side | null;
  /** 下に来る側（省略時は自分の色、観戦なら先手）。 */
  orientation?: Side;
  lastMove?: { usi: string; label: string } | null;
  /** 自分の番で指せるとき true。 */
  canMove: boolean;
  /** 合法手（USI）。渡されなければ局面から計算する。 */
  legalMoves?: string[] | null;
  settings?: Partial<BoardSettings>;
  /** 観戦の寸法（1 升 約 35×38）。 */
  compact?: boolean;
  /** 盤全体（持ち駒・帯を含む）をこの高さ（px）に収める。チャットを見えるように残すため（ルームの地図と同じ考え方）。 */
  maxHeight?: number;
  theme?: BoardTheme;
  /** 盤の上下の行に出す文字（名前・残り時間など）。上 = 相手、下 = 自分の側。 */
  topLabel?: string;
  bottomLabel?: string;
  /** 帯の右に「✕」（閉じる）を出す。 */
  showClose?: boolean;
  /** 上の帯（直前の手・⇅・✕）を出さない。狭い画面でアプリが自分の 1 行に直前の手と反転をまとめるとき。 */
  hideBand?: boolean;
};

export type BoardCallbacks = {
  onMove?: (usi: string, label: string) => void;
  onHaptic?: (kind: Haptic) => void;
  onFlip?: (orientation: Side) => void;
  onClose?: () => void;
  /** 盤の高さが変わったとき（WebView の高さ合わせ用）。 */
  onResize?: (height: number) => void;
};

const KANJI_RANK = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];
const HAND_ORDER: PieceType[] = [
  PieceType.ROOK,
  PieceType.BISHOP,
  PieceType.GOLD,
  PieceType.SILVER,
  PieceType.KNIGHT,
  PieceType.LANCE,
  PieceType.PAWN,
];
const USI_PIECE: Partial<Record<PieceType, string>> = {
  [PieceType.ROOK]: "R",
  [PieceType.BISHOP]: "B",
  [PieceType.GOLD]: "G",
  [PieceType.SILVER]: "S",
  [PieceType.KNIGHT]: "N",
  [PieceType.LANCE]: "L",
  [PieceType.PAWN]: "P",
};
const PROMOTED = new Set<PieceType>([
  PieceType.DRAGON,
  PieceType.HORSE,
  PieceType.PROM_SILVER,
  PieceType.PROM_KNIGHT,
  PieceType.PROM_LANCE,
  PieceType.PROM_PAWN,
]);

/** 駒の字（先手の玉・後手の王）。 */
export function pieceChar(t: PieceType, color: Color): string {
  switch (t) {
    case PieceType.KING:
      return color === Color.BLACK ? "玉" : "王";
    case PieceType.ROOK:
      return "飛";
    case PieceType.BISHOP:
      return "角";
    case PieceType.GOLD:
      return "金";
    case PieceType.SILVER:
      return "銀";
    case PieceType.KNIGHT:
      return "桂";
    case PieceType.LANCE:
      return "香";
    case PieceType.PAWN:
      return "歩";
    case PieceType.DRAGON:
      return "龍";
    case PieceType.HORSE:
      return "馬";
    case PieceType.PROM_SILVER:
      return "全";
    case PieceType.PROM_KNIGHT:
      return "圭";
    case PieceType.PROM_LANCE:
      return "杏";
    case PieceType.PROM_PAWN:
      return "と";
  }
}

const colorOf = (s: Side): Color => (s === "black" ? Color.BLACK : Color.WHITE);

/** 画面上の (列, 行) → 升。orientation = 下に来る側。 */
export function squareAt(col: number, row: number, orientation: Side): Square {
  return orientation === "black" ? new Square(9 - col, row + 1) : new Square(col + 1, 9 - row);
}

type Selection = { kind: "square"; usi: string } | { kind: "hand"; letter: string } | null;

const STYLE_ID = "bguru-shogi-board-style";

export const BOARD_CSS = `
@font-face{font-family:"BguruShogiPiece";src:url("/shogi-board/fonts/shogi-piece.ttf") format("truetype");font-display:swap;}
.sb-root{--sb-frame1:#a8784f;--sb-frame2:#7c5434;--sb-frame-ink:#fbf7f0;--sb-board:#fdf0d2;--sb-line:rgba(124,84,52,.34);--sb-star:rgba(90,58,30,.55);--sb-piece1:#ffffff;--sb-piece2:#fbf3e4;--sb-piece-edge:#2a2118;--sb-ink:#2a2118;--sb-prom:#dc2626;--sb-last:rgba(251,191,36,.42);--sb-sel:rgba(22,163,74,.30);--sb-dot:#16a34a;--sb-dot-ring:rgba(255,255,255,.85);--sb-cap:#dc2626;--sb-text:#2a2118;--sb-dim:#7a6a58;--sb-band:#efe5d6;--sb-tray:#efe5d6;--sb-tray-edge:#e2d6c4;--sb-badge:#2a2118;--sb-badge-ink:#fbf7f0;--sb-btn:#fbf7f0;--sb-btn-text:#2a2118;--sb-btn-edge:#e2d6c4;--sb-accent:#16a34a;--sb-accent-ink:#fff;--sb-label:#9e503c;
  --cw:39px;--ch:43px;--hw:30px;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif;color:var(--sb-text);user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;touch-action:none;position:relative;width:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:3px}
.sb-root[data-theme="dark"]{--sb-frame1:#6e4b2f;--sb-frame2:#4a3120;--sb-frame-ink:#f1e8dc;--sb-board:#3a3027;--sb-line:rgba(241,232,220,.17);--sb-star:rgba(241,232,220,.45);--sb-piece1:#f6eee2;--sb-piece2:#e6d9c5;--sb-piece-edge:#0d0b09;--sb-ink:#1d1915;--sb-prom:#d42020;--sb-last:rgba(234,108,60,.40);--sb-sel:rgba(34,197,94,.36);--sb-dot:#22c55e;--sb-dot-ring:rgba(13,11,9,.7);--sb-cap:#f87171;--sb-text:#f1e8dc;--sb-dim:#a8988a;--sb-band:#2a241e;--sb-tray:#2a241e;--sb-tray-edge:#3a3128;--sb-badge:#f1e8dc;--sb-badge-ink:#14110e;--sb-btn:#1d1915;--sb-btn-text:#f1e8dc;--sb-btn-edge:#3a3128;--sb-accent:#22c55e;--sb-accent-ink:#06210f}
@media (prefers-color-scheme: dark){.sb-root[data-theme="auto"]{--sb-frame1:#6e4b2f;--sb-frame2:#4a3120;--sb-frame-ink:#f1e8dc;--sb-board:#3a3027;--sb-line:rgba(241,232,220,.17);--sb-star:rgba(241,232,220,.45);--sb-piece1:#f6eee2;--sb-piece2:#e6d9c5;--sb-piece-edge:#0d0b09;--sb-ink:#1d1915;--sb-prom:#d42020;--sb-last:rgba(234,108,60,.40);--sb-sel:rgba(34,197,94,.36);--sb-dot:#22c55e;--sb-dot-ring:rgba(13,11,9,.7);--sb-cap:#f87171;--sb-text:#f1e8dc;--sb-dim:#a8988a;--sb-band:#2a241e;--sb-tray:#2a241e;--sb-tray-edge:#3a3128;--sb-badge:#f1e8dc;--sb-badge-ink:#14110e;--sb-btn:#1d1915;--sb-btn-text:#f1e8dc;--sb-btn-edge:#3a3128;--sb-accent:#22c55e;--sb-accent-ink:#06210f}}
.sb-band{display:flex;align-items:center;gap:6px;width:var(--sb-w);box-sizing:border-box;padding:2px 3px 2px 6px;border-radius:999px;background:var(--sb-band);font-size:14px;font-weight:700;min-height:28px}
.sb-band .sb-label{flex:1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sb-disc{flex:none;width:18px;height:18px;border-radius:50%;background:radial-gradient(circle,#111 0 1.2px,var(--sb-label) 1.6px 4.6px,#1c1c1c 5px,#111 6px,#222 6.6px,#111 7.4px,#1a1a1a 8.2px,#0d0d0d 9px);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.sb-band button,.sb-confirm button,.sb-promo button{font:inherit;border:1px solid var(--sb-btn-edge);background:var(--sb-btn);color:var(--sb-btn-text);border-radius:999px;padding:2px 10px;cursor:pointer;line-height:1.4;font-weight:700}
.sb-who{display:flex;align-items:baseline;width:var(--sb-w);box-sizing:border-box;padding:0 4px;font-size:12px;line-height:16px;height:16px;color:var(--sb-dim);white-space:nowrap;font-variant-numeric:tabular-nums}
.sb-who-bottom{justify-content:flex-end}
.sb-who .sb-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.sb-who .sb-tail{flex:none;white-space:pre;color:var(--sb-text);font-weight:700}
.sb-main{display:flex;align-items:stretch;gap:3px}
.sb-hand{width:var(--hw);flex:none;display:flex;flex-direction:column;align-items:stretch;gap:2px;box-sizing:border-box;padding:4px 0;border-radius:10px;background:var(--sb-tray);box-shadow:inset 0 0 0 1px var(--sb-tray-edge)}
.sb-hand-bottom{flex-direction:column-reverse}
.sb-hp{position:relative;display:flex;align-items:center;justify-content:flex-start;padding:0 1px;height:calc(var(--ch)*.8);border-radius:8px;flex:none}
.sb-hand-top .sb-hp{justify-content:flex-end}
.sb-hp.sb-sel{background:var(--sb-sel)}
.sb-hp .sb-n{position:absolute;right:-5px;top:-3px;min-width:max(13px,calc(var(--cw)*.42));height:max(13px,calc(var(--cw)*.42));padding:0 3px;box-sizing:border-box;border-radius:999px;background:var(--sb-badge);color:var(--sb-badge-ink);font-size:max(9px,calc(var(--cw)*.3));line-height:max(13px,calc(var(--cw)*.42));font-weight:800;text-align:center;font-variant-numeric:tabular-nums;pointer-events:none;z-index:2;box-shadow:0 0 0 1.5px var(--sb-tray)}
.sb-hand-top .sb-hp .sb-n{top:auto;bottom:-3px;right:auto;left:-5px}
.sb-wrap{position:relative;display:grid;grid-template-columns:calc(var(--cw)*9 + 2px) 11px;grid-template-rows:13px calc(var(--ch)*9 + 2px);padding:0 2px 3px 3px;background:linear-gradient(135deg,var(--sb-frame1),var(--sb-frame2));border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,.16);box-sizing:content-box}
.sb-files{display:grid;grid-template-columns:repeat(9,var(--cw));padding-left:1px;font-size:9.5px;line-height:13px;text-align:center;color:var(--sb-frame-ink);opacity:.85;font-weight:600;grid-column:1;grid-row:1}
.sb-ranks{display:grid;grid-template-rows:repeat(9,var(--ch));padding-top:1px;font-size:9.5px;align-items:center;justify-items:center;color:var(--sb-frame-ink);opacity:.85;font-family:"BguruShogiPiece","Hiragino Mincho ProN","Yu Mincho","Noto Serif CJK JP","Noto Serif JP",serif;grid-column:2;grid-row:2}
.sb-grid{position:relative;display:grid;grid-template-columns:repeat(9,var(--cw));grid-template-rows:repeat(9,var(--ch));border:1px solid var(--sb-line);border-radius:7px;background:var(--sb-board);grid-column:1;grid-row:2;box-shadow:inset 0 1px 3px rgba(0,0,0,.12)}
.sb-star{position:absolute;width:5px;height:5px;margin:-2.5px 0 0 -2.5px;border-radius:50%;background:var(--sb-star);pointer-events:none;z-index:1}
.sb-cell{position:relative;border-right:1px solid var(--sb-line);border-bottom:1px solid var(--sb-line);box-sizing:border-box;display:flex;align-items:center;justify-content:center}
.sb-cell.sb-r{border-right:none}
.sb-cell.sb-b{border-bottom:none}
.sb-cell.sb-last{background:var(--sb-last)}
.sb-cell.sb-sel{background:var(--sb-sel)}
.sb-dot{position:absolute;width:30%;height:30%;border-radius:50%;background:var(--sb-dot);box-shadow:0 0 0 2px var(--sb-dot-ring);pointer-events:none;z-index:2}
.sb-cap{position:absolute;inset:2px;border-radius:7px;pointer-events:none;z-index:2;box-shadow:inset 0 0 0 2.5px var(--sb-cap)}
.sb-piece{position:relative;width:calc(var(--cw)*.86);height:calc(var(--ch)*.9);display:flex;align-items:center;justify-content:center;pointer-events:none;filter:drop-shadow(0 1.5px 0 rgba(0,0,0,.18))}
.sb-piece::before{content:"";position:absolute;inset:0;background:var(--sb-piece-edge);clip-path:polygon(50% 0,85% 15%,100% 100%,0 100%,15% 15%)}
.sb-piece::after{content:"";position:absolute;inset:1.4px 1.6px 1.4px 1.6px;background:linear-gradient(170deg,var(--sb-piece1) 40%,var(--sb-piece2));clip-path:polygon(50% 0,85% 15%,100% 100%,0 100%,15% 15%)}
.sb-piece span{position:relative;z-index:1;font-family:"BguruShogiPiece","Hiragino Mincho ProN","Yu Mincho","YuMincho","Noto Serif CJK JP","Noto Serif JP",serif;font-weight:700;font-size:calc(var(--cw)*.62);line-height:1;color:var(--sb-ink);margin-top:calc(var(--ch)*.1)}
.sb-piece.sb-prom span{color:var(--sb-prom)}
.sb-piece.sb-rot{transform:rotate(180deg)}
.sb-piece.sb-rot{filter:drop-shadow(0 -1.5px 0 rgba(0,0,0,.18))}
.sb-hand .sb-piece{width:calc(var(--cw)*.68);height:calc(var(--ch)*.74)}
.sb-hand .sb-piece span{font-size:calc(var(--cw)*.5)}
.sb-dragging{opacity:.3}
.sb-ghost{position:fixed;z-index:1000;pointer-events:none;transform:translate(-50%,-60%) scale(1.2);width:var(--cw);height:var(--ch)}
.sb-ghost .sb-piece{width:100%;height:100%;filter:drop-shadow(0 4px 6px rgba(0,0,0,.3))}
.sb-promo{position:absolute;z-index:20;display:flex;gap:3px;transform:translate(-50%,-100%);background:var(--sb-band);padding:3px;border-radius:999px;box-shadow:0 3px 12px rgba(0,0,0,.3)}
.sb-promo button{font-size:15px;padding:4px 12px}
.sb-promo button.sb-yes{background:var(--sb-prom);border-color:var(--sb-prom);color:#fff}
.sb-confirm{display:flex;align-items:center;gap:8px;font-size:14px}
.sb-confirm button.sb-go{background:var(--sb-accent);color:var(--sb-accent-ink);border-color:var(--sb-accent)}
.sb-root.sb-pending .sb-grid{opacity:.92}
`;

function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = BOARD_CSS;
  doc.head.appendChild(st);
}

/** 盤面の部品。mount した要素の中に描き、setState で描き直す。 */
export class ShogiBoardView {
  private el: HTMLElement;
  private cb: BoardCallbacks;
  private state: BoardState;
  private pos: Position;
  private legal: Set<string> = new Set();
  private legalFor = "";
  private orientation: Side;
  private sel: Selection = null;
  private promo: { from: string; to: string } | null = null;
  private pending: { usi: string; label: string } | null = null;
  /** 指したあと、ホストから次の状態が来るまでの仮の局面。 */
  private optimistic: { sfen: string; lastMove: { usi: string; label: string } } | null = null;
  private drag: {
    id: number;
    x: number;
    y: number;
    moved: boolean;
    /** 選んでいた駒をもう一度押した（タップなら選択を外す）。 */
    same: boolean;
    ghost: HTMLElement | null;
    srcEl: HTMLElement | null;
  } | null = null;
  private ro: ResizeObserver | null = null;
  private lastHeight = 0;
  private destroyed = false;

  constructor(el: HTMLElement, state: BoardState, cb: BoardCallbacks = {}) {
    this.el = el;
    this.cb = cb;
    this.state = state;
    this.orientation = state.orientation ?? state.myColor ?? "black";
    this.pos = Position.newBySFEN(state.sfen) ?? new Position();
    ensureStyles(el.ownerDocument);
    el.classList.add("sb-root");
    el.addEventListener("pointerdown", this.onDown);
    el.addEventListener("pointermove", this.onMoveEv);
    el.addEventListener("pointerup", this.onUp);
    el.addEventListener("pointercancel", this.onCancel);
    el.addEventListener("click", this.onClick);
    if (typeof ResizeObserver !== "undefined") {
      this.ro = new ResizeObserver(() => this.fit());
      this.ro.observe(el);
    }
    this.fit();
    this.render();
  }

  destroy(): void {
    this.destroyed = true;
    this.ro?.disconnect();
    this.el.removeEventListener("pointerdown", this.onDown);
    this.el.removeEventListener("pointermove", this.onMoveEv);
    this.el.removeEventListener("pointerup", this.onUp);
    this.el.removeEventListener("pointercancel", this.onCancel);
    this.el.removeEventListener("click", this.onClick);
    this.drag?.ghost?.remove();
    this.el.innerHTML = "";
    this.el.classList.remove("sb-root");
  }

  setState(next: BoardState): void {
    const prev = this.state;
    this.state = next;
    const refit = next.maxHeight !== prev.maxHeight || next.compact !== prev.compact || next.hideBand !== prev.hideBand;
    // 向き: ホストが決めていればそれ。決めていなければ、自分の色が変わったときだけ合わせる（⇅ は残す）。
    if (next.orientation != null) this.orientation = next.orientation;
    else if (next.myColor !== prev.myColor && next.myColor) this.orientation = next.myColor;
    const prevSfen = prev.sfen;
    this.optimistic = null;
    if (next.sfen !== prevSfen || !next.canMove) {
      this.sel = null;
      this.promo = null;
      this.pending = null;
    }
    this.render();
    if (refit) this.fit();
  }

  /** 持ち駒の行の文字だけを変える（時計の表示など。描き直さないので選択・ドラッグ・送信中の局面は残る）。 */
  setLabels(topLabel?: string, bottomLabel?: string): void {
    this.state = { ...this.state, topLabel, bottomLabel };
    const top = this.el.querySelector(".sb-who-top");
    const bottom = this.el.querySelector(".sb-who-bottom");
    if (!!top !== !!topLabel || !!bottom !== !!bottomLabel) {
      if (!this.drag) this.render();
      return;
    }
    const mark = (where: "top" | "bottom") => {
      const bottomSide = this.orientation;
      const s = where === "bottom" ? bottomSide : bottomSide === "black" ? "white" : "black";
      return s === "black" ? "☗" : "☖";
    };
    if (top && topLabel) this.fillWho(top, mark("top"), topLabel);
    if (bottom && bottomLabel) this.fillWho(bottom, mark("bottom"), bottomLabel);
  }

  /** 名前と、後ろの時計・手番の印を分けて入れる（狭いときに切るのは名前だけ。時計と ● は残す）。 */
  private fillWho(el: Element, mark: string, label: string): void {
    const m = label.match(/^(.*?)(\s+\d+:\d{2}.*|\s*[（(]手番[)）].*|\s*●.*)$/);
    const name = m ? m[1] : label;
    const tail = m ? m[2] : "";
    const doc = el.ownerDocument;
    const n = doc.createElement("span");
    n.className = "sb-name";
    n.textContent = `${mark}${name}`;
    el.replaceChildren(n);
    if (tail) {
      const t = doc.createElement("span");
      t.className = "sb-tail";
      t.textContent = tail;
      el.appendChild(t);
    }
    el.setAttribute("title", `${mark}${label}`);
  }

  /** ⇅（下に来る側を入れ替える）。 */
  flip(): void {
    this.orientation = this.orientation === "black" ? "white" : "black";
    this.promo = null;
    this.render();
    this.cb.onFlip?.(this.orientation);
  }

  getOrientation(): Side {
    return this.orientation;
  }

  // ─────────────────────────── 寸法

  /** 横幅: 9 升 + 盤の縁と段の数字 + 左右の駒台（升の 0.84 倍ずつ）+ すき間。 */
  private static readonly FIXED_W = 2 + 11 + 5 + 6;
  private static readonly HAND_RATIO = 0.84;

  private applyCell(cw: number): void {
    const hw = Math.round(cw * ShogiBoardView.HAND_RATIO);
    this.el.style.setProperty("--cw", `${cw}px`);
    this.el.style.setProperty("--ch", `${Math.round(cw * 1.1)}px`);
    this.el.style.setProperty("--hw", `${hw}px`);
    this.el.style.setProperty("--sb-w", `${cw * 9 + 2 * hw + ShogiBoardView.FIXED_W}px`);
  }

  private fit(): void {
    const w = this.el.clientWidth || 360;
    // 広い画面でも盤が大きくなりすぎないように（升 48px ≒ 盤全体 幅 540px）。観戦は小さめ。
    const maxCell = this.state.compact ? 35 : 48;
    const cw = Math.max(22, Math.min(maxCell, Math.floor((w - ShogiBoardView.FIXED_W) / (9 + 2 * ShogiBoardView.HAND_RATIO))));
    this.applyCell(cw);
    // 高さの上限: 升の高さに比例する部分（盤 9 升。持ち駒は左右なので高さに足さない）と、帯・名前の行などの決まった部分に分けて縮める。
    const max = this.state.maxHeight;
    if (max && max > 0) {
      // 見積もりで縮めたあと、実際に測って収まるまで 1px ずつ詰める（帯の折り返しなどで見積もりがずれるため）。
      let cur = cw;
      let h = this.el.scrollHeight;
      if (h > max) {
        const fixed = Math.max(0, h - 9 * Math.round(cur * 1.1));
        cur = Math.max(22, Math.min(cur, Math.floor(Math.floor((max - fixed) / 9) / 1.1)));
        for (let i = 0; i < 30; i++) {
          this.applyCell(cur);
          h = this.el.scrollHeight;
          if (h <= max || cur <= 22) break;
          cur -= 1;
        }
      }
    }
    this.reportHeight();
  }

  private reportHeight(): void {
    const h = Math.ceil(this.el.scrollHeight);
    if (h && h !== this.lastHeight) {
      this.lastHeight = h;
      this.cb.onResize?.(h);
    }
  }

  // ─────────────────────────── 局面

  private shownSfen(): string {
    return this.optimistic?.sfen ?? this.state.sfen;
  }

  private canMoveNow(): boolean {
    return !!this.state.canMove && !!this.state.myColor && !this.optimistic;
  }

  private legalMoves(): Set<string> {
    if (!this.canMoveNow()) return new Set();
    const key = `${this.state.sfen}|${this.state.legalMoves ? this.state.legalMoves.length : "auto"}`;
    if (key !== this.legalFor) {
      this.legalFor = key;
      this.legal = new Set(this.state.legalMoves ?? legalUsi(this.state.sfen));
    }
    return this.legal;
  }

  private settings(): BoardSettings {
    return { confirmMove: !!this.state.settings?.confirmMove, moveHints: this.state.settings?.moveHints !== false };
  }

  /** 選んでいる駒の行き先 → { 不成で行けるか, 成って行けるか }。 */
  private targets(): Map<string, { plain: boolean; promo: boolean }> {
    const out = new Map<string, { plain: boolean; promo: boolean }>();
    const sel = this.sel;
    if (!sel || this.pending) return out;
    const prefix = sel.kind === "square" ? sel.usi : `${sel.letter}*`;
    for (const m of this.legalMoves()) {
      if (!m.startsWith(prefix)) continue;
      const to = m.slice(2, 4);
      const t = out.get(to) ?? { plain: false, promo: false };
      if (m.endsWith("+")) t.promo = true;
      else t.plain = true;
      out.set(to, t);
    }
    return out;
  }

  // ─────────────────────────── 描画

  private render(): void {
    if (this.destroyed) return;
    const doc = this.el.ownerDocument;
    const st = this.state;
    this.el.dataset.theme = st.theme ?? "auto";
    this.el.classList.toggle("sb-pending", !!this.optimistic);
    this.fit();
    const sfen = this.shownSfen();
    const pos = Position.newBySFEN(sfen) ?? new Position();
    this.pos = pos;
    const last = this.optimistic?.lastMove ?? st.lastMove ?? null;
    const orient = this.orientation;
    const bottom = colorOf(orient);
    const top = bottom === Color.BLACK ? Color.WHITE : Color.BLACK;
    const targets = this.targets();
    const hints = this.settings().moveHints;

    const root = doc.createDocumentFragment();

    // 帯: 最後の手（▲7六歩）と ⇅・✕
    const band = doc.createElement("div");
    band.className = "sb-band";
    const disc = doc.createElement("i");
    disc.className = "sb-disc";
    disc.setAttribute("aria-hidden", "true");
    band.appendChild(disc);
    const label = doc.createElement("span");
    label.className = "sb-label";
    label.textContent = last ? `${last.label}${this.optimistic ? "（送信中）" : ""}` : "対局開始";
    band.appendChild(label);
    const flipBtn = doc.createElement("button");
    flipBtn.type = "button";
    flipBtn.dataset.act = "flip";
    flipBtn.textContent = "⇅";
    flipBtn.title = "盤を反転";
    flipBtn.setAttribute("aria-label", "盤を反転");
    band.appendChild(flipBtn);
    if (st.showClose) {
      const close = doc.createElement("button");
      close.type = "button";
      close.dataset.act = "close";
      close.textContent = "✕";
      close.setAttribute("aria-label", "閉じる");
      band.appendChild(close);
    }
    if (!st.hideBand) root.appendChild(band);

    if (st.topLabel) root.appendChild(this.renderWho(doc, top, "top", st.topLabel));
    const main = doc.createElement("div");
    main.className = "sb-main";
    main.appendChild(this.renderHand(doc, pos, top, "top"));

    const wrap = doc.createElement("div");
    wrap.className = "sb-wrap";
    const files = doc.createElement("div");
    files.className = "sb-files";
    for (let c = 0; c < 9; c++) {
      const s = doc.createElement("span");
      s.textContent = String(orient === "black" ? 9 - c : c + 1);
      files.appendChild(s);
    }
    wrap.appendChild(files);
    const grid = doc.createElement("div");
    grid.className = "sb-grid";
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-label", "将棋盤");
    const lastFrom = last && /^[1-9][a-i]/.test(last.usi) ? last.usi.slice(0, 2) : null;
    const lastTo = last ? last.usi.slice(2, 4) : null;
    // 星（3 と 6 の筋・段の交点）
    for (const [c, r] of [[3, 3], [6, 3], [3, 6], [6, 6]]) {
      const star = doc.createElement("i");
      star.className = "sb-star";
      star.style.left = `calc(var(--cw) * ${c})`;
      star.style.top = `calc(var(--ch) * ${r})`;
      grid.appendChild(star);
    }
    for (let row = 0; row < 9; row++) {
      for (let col = 0; col < 9; col++) {
        const sq = squareAt(col, row, orient);
        const usi = sq.usi;
        const cell = doc.createElement("div");
        cell.className = `sb-cell${col === 8 ? " sb-r" : ""}${row === 8 ? " sb-b" : ""}`;
        cell.dataset.sq = usi;
        if (usi === lastTo || usi === lastFrom) cell.classList.add("sb-last");
        if (this.sel?.kind === "square" && this.sel.usi === usi) cell.classList.add("sb-sel");
        const p = pos.board.at(sq);
        if (p) {
          cell.appendChild(this.pieceEl(doc, p.type, p.color, p.color !== bottom));
          cell.setAttribute("aria-label", `${sq.file}${KANJI_RANK[sq.rank - 1]} ${p.color === Color.BLACK ? "先手" : "後手"}の${pieceChar(p.type, p.color)}`);
        }
        const t = targets.get(usi);
        if (t && hints) {
          const mark = doc.createElement("i");
          mark.className = p ? "sb-cap" : "sb-dot";
          cell.appendChild(mark);
        }
        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);
    const ranks = doc.createElement("div");
    ranks.className = "sb-ranks";
    for (let r = 0; r < 9; r++) {
      const s = doc.createElement("span");
      s.textContent = KANJI_RANK[orient === "black" ? r : 8 - r];
      ranks.appendChild(s);
    }
    wrap.appendChild(ranks);

    if (this.promo) {
      const box = doc.createElement("div");
      box.className = "sb-promo";
      const { col, row } = this.cellPos(this.promo.to);
      box.style.left = `calc(var(--cw) * ${col + 0.5})`;
      box.style.top = `calc(var(--ch) * ${row})`;
      const yes = doc.createElement("button");
      yes.type = "button";
      yes.className = "sb-yes";
      yes.dataset.act = "promote";
      yes.textContent = "成";
      const no = doc.createElement("button");
      no.type = "button";
      no.dataset.act = "nopromote";
      no.textContent = "不成";
      box.append(yes, no);
      grid.appendChild(box);
    }
    main.appendChild(wrap);
    main.appendChild(this.renderHand(doc, pos, bottom, "bottom"));
    root.appendChild(main);
    if (st.bottomLabel) root.appendChild(this.renderWho(doc, bottom, "bottom", st.bottomLabel));

    if (this.pending) {
      const bar = doc.createElement("div");
      bar.className = "sb-confirm";
      const t = doc.createElement("span");
      t.textContent = `${this.pending.label} を指しますか？`;
      const go = doc.createElement("button");
      go.type = "button";
      go.className = "sb-go";
      go.dataset.act = "confirm";
      go.textContent = "指す";
      const back = doc.createElement("button");
      back.type = "button";
      back.dataset.act = "unconfirm";
      back.textContent = "やめる";
      bar.append(t, go, back);
      root.appendChild(bar);
    }

    this.el.replaceChildren(root);
    // 名前の行・確認の行の有無で高さが変わるので、高さの上限があれば測り直す。
    if (this.state.maxHeight) this.fit();
    else this.reportHeight();
  }

  /** 盤の上下の細い行（名前・時計）。上 = 左寄せ（相手の駒台の上）、下 = 右寄せ（自分の駒台の下）。 */
  private renderWho(doc: Document, color: Color, where: "top" | "bottom", who: string): HTMLElement {
    const w = doc.createElement("div");
    w.className = `sb-who sb-who-${where}`;
    this.fillWho(w, color === Color.BLACK ? "☗" : "☖", who);
    return w;
  }

  /** 駒台（盤の左右の縦の列）。相手は左で上から、自分は右で下から並べる（CSS の column-reverse）。
   * 駒がなくても幅を取る（盤の位置が動かないように）。7 種類でも盤の高さに収まる（1 種類 = 升の 0.8 倍）。 */
  private renderHand(doc: Document, pos: Position, color: Color, where: "top" | "bottom"): HTMLElement {
    const hand = doc.createElement("div");
    hand.className = `sb-hand sb-hand-${where}`;
    hand.setAttribute("aria-label", `${color === Color.BLACK ? "先手" : "後手"}の持ち駒`);
    const bottomColor = colorOf(this.orientation);
    const h = pos.hand(color);
    for (const t of HAND_ORDER) {
      const n = h.count(t);
      if (n === 0) continue;
      const letter = USI_PIECE[t]!;
      const hp = doc.createElement("span");
      hp.className = "sb-hp";
      hp.dataset.hand = letter;
      hp.dataset.color = color === Color.BLACK ? "black" : "white";
      if (this.sel?.kind === "hand" && this.sel.letter === letter && this.state.myColor && colorOf(this.state.myColor) === color) {
        hp.classList.add("sb-sel");
      }
      hp.appendChild(this.pieceEl(doc, t, color, color !== bottomColor));
      if (n > 1) {
        const c = doc.createElement("span");
        c.className = "sb-n";
        // 狭い列なので数字だけ（駒の空いた角に丸い札）。読み上げは「歩×3」。
        c.textContent = String(n);
        hp.appendChild(c);
      }
      hp.setAttribute("aria-label", `${pieceChar(t, color)}${n > 1 ? `×${n}` : ""}`);
      hand.appendChild(hp);
    }
    return hand;
  }

  private pieceEl(doc: Document, t: PieceType, color: Color, rotate: boolean): HTMLElement {
    const el = doc.createElement("div");
    el.className = `sb-piece${PROMOTED.has(t) ? " sb-prom" : ""}${rotate ? " sb-rot" : ""}`;
    const s = doc.createElement("span");
    s.textContent = pieceChar(t, color);
    el.appendChild(s);
    return el;
  }

  private cellPos(usi: string): { col: number; row: number } {
    const sq = Square.newByUSI(usi)!;
    return this.orientation === "black" ? { col: 9 - sq.file, row: sq.rank - 1 } : { col: sq.file - 1, row: 9 - sq.rank };
  }

  // ─────────────────────────── 操作

  private onClick = (e: MouseEvent): void => {
    const btn = (e.target as HTMLElement).closest("button[data-act]") as HTMLElement | null;
    if (!btn || !this.el.contains(btn)) return;
    e.preventDefault();
    const act = btn.dataset.act;
    if (act === "flip") this.flip();
    else if (act === "close") this.cb.onClose?.();
    else if (act === "promote" && this.promo) this.commit(`${this.promo.from}${this.promo.to}+`);
    else if (act === "nopromote" && this.promo) this.commit(`${this.promo.from}${this.promo.to}`);
    else if (act === "confirm" && this.pending) this.send(this.pending.usi, this.pending.label);
    else if (act === "unconfirm") {
      this.pending = null;
      this.render();
    }
  };

  private hit(x: number, y: number): { sq?: string; hand?: string; handColor?: string } {
    const doc = this.el.ownerDocument;
    const t = doc.elementFromPoint(x, y) as HTMLElement | null;
    if (!t || !this.el.contains(t)) return {};
    const cell = t.closest("[data-sq]") as HTMLElement | null;
    if (cell) return { sq: cell.dataset.sq };
    const hp = t.closest("[data-hand]") as HTMLElement | null;
    if (hp) return { hand: hp.dataset.hand, handColor: hp.dataset.color };
    return {};
  }

  private isMine(sq: string): boolean {
    const my = this.state.myColor;
    if (!my) return false;
    const p = this.pos.board.at(Square.newByUSI(sq)!);
    return !!p && p.color === colorOf(my);
  }

  private onDown = (e: PointerEvent): void => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (this.pending) return;
    const h = this.hit(e.clientX, e.clientY);
    if (!h.sq && !h.hand) {
      if (this.promo || this.sel) {
        this.promo = null;
        this.sel = null;
        this.render();
      }
      return;
    }
    if (this.promo) {
      this.promo = null;
      this.render();
      return;
    }
    if (!this.canMoveNow()) return;
    const my = this.state.myColor!;
    // 行き先のタップ（選んでいる駒がある）
    if (h.sq && this.sel) {
      const t = this.targets().get(h.sq);
      if (t) {
        this.choose(h.sq, t);
        return;
      }
    }
    // 自分の駒（盤上・持ち駒）を選ぶ／ドラッグを始める
    const ownHand = !!h.hand && h.handColor === my;
    const ownSq = !!h.sq && this.isMine(h.sq);
    if (ownHand || ownSq) {
      const next: Selection = ownSq ? { kind: "square", usi: h.sq! } : { kind: "hand", letter: h.hand! };
      const same =
        (this.sel?.kind === "square" && next.kind === "square" && this.sel.usi === next.usi) ||
        (this.sel?.kind === "hand" && next.kind === "hand" && this.sel.letter === next.letter);
      this.sel = next;
      if (!same) this.cb.onHaptic?.("select");
      this.render();
      const src = ownSq
        ? (this.el.querySelector(`[data-sq="${h.sq}"] .sb-piece`) as HTMLElement | null)
        : (this.el.querySelector(`[data-hand="${h.hand}"][data-color="${my}"] .sb-piece`) as HTMLElement | null);
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, same, ghost: null, srcEl: src };
      try {
        this.el.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable (synthetic event) */
      }
      e.preventDefault();
      return;
    }
    // それ以外: 選択を外す（反則の升には点を出さないので、ここは「指せない」）
    if (this.sel) {
      this.sel = null;
      this.cb.onHaptic?.("error");
      this.render();
    }
  };

  private onMoveEv = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6) return;
    if (!d.moved) {
      d.moved = true;
      const doc = this.el.ownerDocument;
      const g = doc.createElement("div");
      g.className = "sb-ghost sb-root";
      g.dataset.theme = this.el.dataset.theme ?? "auto";
      g.style.setProperty("--cw", this.el.style.getPropertyValue("--cw"));
      g.style.setProperty("--ch", this.el.style.getPropertyValue("--ch"));
      if (d.srcEl) {
        const clone = d.srcEl.cloneNode(true) as HTMLElement;
        g.appendChild(clone);
        d.srcEl.classList.add("sb-dragging");
      }
      doc.body.appendChild(g);
      d.ghost = g;
    }
    if (d.ghost) {
      d.ghost.style.left = `${e.clientX}px`;
      d.ghost.style.top = `${e.clientY}px`;
    }
  };

  private onUp = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    d.ghost?.remove();
    d.srcEl?.classList.remove("sb-dragging");
    if (!d.moved) {
      // タップで同じ駒をもう一度押したら選択を外す
      if (d.same) {
        this.sel = null;
        this.render();
      }
      return;
    }
    const h = this.hit(e.clientX, e.clientY);
    if (h.sq) {
      const t = this.targets().get(h.sq);
      if (t) {
        this.choose(h.sq, t);
        return;
      }
      if (h.sq !== (this.sel?.kind === "square" ? this.sel.usi : null)) this.cb.onHaptic?.("error");
    }
    this.render();
  };

  private onCancel = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d || d.id !== e.pointerId) return;
    this.drag = null;
    d.ghost?.remove();
    d.srcEl?.classList.remove("sb-dragging");
  };

  private choose(to: string, t: { plain: boolean; promo: boolean }): void {
    const sel = this.sel;
    if (!sel) return;
    if (sel.kind === "hand") {
      this.commit(`${sel.letter}*${to}`);
      return;
    }
    if (t.plain && t.promo) {
      this.promo = { from: sel.usi, to };
      this.render();
      return;
    }
    // 行き所のない駒は自動で成る（成りしか合法手がない）
    this.commit(t.promo ? `${sel.usi}${to}+` : `${sel.usi}${to}`);
  }

  private commit(usi: string): void {
    this.promo = null;
    const label = this.legalMoves().has(usi) ? labelFor(this.pos, usi, this.state.lastMove?.usi ?? null) : null;
    if (!label) {
      this.cb.onHaptic?.("error");
      this.render();
      return;
    }
    if (this.settings().confirmMove) {
      this.pending = { usi, label };
      this.render();
      return;
    }
    this.send(usi, label);
  }

  private send(usi: string, label: string): void {
    this.pending = null;
    this.sel = null;
    const after = this.pos.clone();
    const m = after.createMoveByUSI(usi);
    if (m && after.doMove(m)) this.optimistic = { sfen: after.sfen, lastMove: { usi, label } };
    this.cb.onHaptic?.("move");
    this.render();
    this.cb.onMove?.(usi, label);
  }
}
