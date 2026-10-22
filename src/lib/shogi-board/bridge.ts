/* ☗ 将棋の盤面 — アプリの WebView 用の薄い橋渡し（bridge_version 1）。
 * /shogi-board/index.html が読み込む board.js の入口（scripts/build-shogi-board.mjs で束ねる）。
 * 約束の正本は docs/shogi-spec.md「盤面の橋渡し」。トークンは受け取らない・持たない・送らない。
 *
 *   アプリ → 盤: window.shogiBoard.receive(msg)（msg はオブジェクトか JSON 文字列）、
 *               または window.postMessage(msg)（Android の postWebMessage・iframe）。
 *   盤 → アプリ: iOS/Mac  window.webkit.messageHandlers.shogi.postMessage(obj)
 *               Android  window.ShogiBridge.postMessage(JSON 文字列)
 *               iframe   window.parent.postMessage(obj, "*")
 *               （どれもなければ window の CustomEvent "shogi-board"） */
import { ShogiBoardView, type BoardCommentary, type BoardState, type BoardTheme } from "./board";
import type { Side } from "../shogi-rules";
import { INITIAL_SFEN } from "../shogi-rules";

export const BRIDGE_VERSION = 1;

type Out =
  | { type: "ready"; v: number }
  | { type: "move"; v: number; usi: string; label: string }
  | { type: "haptic"; v: number; kind: "select" | "move" | "error" }
  | { type: "flip"; v: number; orientation: Side }
  | { type: "size"; v: number; height: number }
  | { type: "close"; v: number }
  | { type: "error"; v: number; message: string };

type W = Window & {
  webkit?: { messageHandlers?: { shogi?: { postMessage: (m: unknown) => void } } };
  ShogiBridge?: { postMessage: (s: string) => void };
  shogiBoard?: { receive: (m: unknown) => void; version: number; features: string[] };
};

function post(msg: Out): void {
  const w = window as W;
  try {
    if (w.webkit?.messageHandlers?.shogi) {
      w.webkit.messageHandlers.shogi.postMessage(msg);
      return;
    }
    if (w.ShogiBridge?.postMessage) {
      w.ShogiBridge.postMessage(JSON.stringify(msg));
      return;
    }
    if (w.parent && w.parent !== w) {
      w.parent.postMessage({ source: "bguru-shogi-board", ...msg }, "*");
      return;
    }
  } catch {
    /* fall through to the DOM event */
  }
  w.dispatchEvent(new CustomEvent("shogi-board", { detail: msg }));
}

const side = (v: unknown): Side | null => (v === "black" || v === "white" ? v : null);
const theme = (v: unknown): BoardTheme => (v === "light" || v === "dark" ? v : "auto");
const str = (v: unknown, max = 200): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);

/** 実況（{ text, eval_cp, mate, ply, move_label }）→ 盤の実況。null・不正なら null（帯を出さない）。
 *  サーバの ShogiCommentaryDto（stream の shogi_commentary・GET games/{id} の commentary）をそのまま渡してよい。 */
export function toBoardCommentary(v: unknown): BoardCommentary | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c.text !== "string") return null;
  const ev = typeof c.eval_cp === "number" && Number.isFinite(c.eval_cp) ? Math.max(-99999, Math.min(99999, c.eval_cp)) : null;
  const ply = typeof c.ply === "number" && Number.isInteger(c.ply) && c.ply >= 0 ? c.ply : null;
  return { text: c.text.slice(0, 140), evalCp: ev, mate: side(c.mate), ply, moveLabel: str(c.move_label, 24) ?? null };
}

/** アプリから来た state メッセージ → 盤の状態（不正な値は捨てる）。 */
export function toBoardState(m: Record<string, unknown>, prev: BoardState): BoardState {
  const settings = (m.settings && typeof m.settings === "object" ? m.settings : {}) as Record<string, unknown>;
  const lm = m.last_move && typeof m.last_move === "object" ? (m.last_move as Record<string, unknown>) : null;
  const legal = Array.isArray(m.legal_moves) ? m.legal_moves.filter((x): x is string => typeof x === "string").slice(0, 1000) : null;
  return {
    sfen: typeof m.sfen === "string" && m.sfen.length < 200 ? m.sfen : prev.sfen,
    myColor: "my_color" in m ? side(m.my_color) : prev.myColor,
    orientation: side(m.orientation) ?? undefined,
    lastMove:
      "last_move" in m
        ? lm && typeof lm.usi === "string"
          ? { usi: lm.usi, label: typeof lm.label === "string" ? lm.label : "" }
          : null
        : prev.lastMove,
    canMove: m.can_move === true,
    legalMoves: legal,
    settings: {
      confirmMove: typeof settings.confirm_move === "boolean" ? settings.confirm_move : prev.settings?.confirmMove,
      moveHints: typeof settings.move_hints === "boolean" ? settings.move_hints : prev.settings?.moveHints,
    },
    compact: typeof m.compact === "boolean" ? m.compact : prev.compact,
    maxHeight: typeof m.max_height === "number" && m.max_height > 0 ? m.max_height : m.max_height === null ? undefined : prev.maxHeight,
    theme: "theme" in m ? theme(m.theme) : prev.theme,
    topLabel: "top_label" in m ? str(m.top_label) : prev.topLabel,
    bottomLabel: "bottom_label" in m ? str(m.bottom_label) : prev.bottomLabel,
    showClose: typeof m.show_close === "boolean" ? m.show_close : prev.showClose,
    hideBand: typeof m.hide_band === "boolean" ? m.hide_band : prev.hideBand,
    // 実況: state に入っていればそれ（null で消す）、なければ前のまま（実況は state と別の便で来る）。
    commentary: "commentary" in m ? toBoardCommentary(m.commentary) : prev.commentary,
  };
}

export function startBridge(el: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  let state: BoardState = {
    sfen: INITIAL_SFEN,
    myColor: null,
    canMove: false,
    theme: theme(params.get("theme")),
    compact: params.get("compact") === "1",
    settings: { confirmMove: false, moveHints: true },
  };
  const view = new ShogiBoardView(el, state, {
    onMove: (usi, label) => post({ type: "move", v: BRIDGE_VERSION, usi, label }),
    onHaptic: (kind) => post({ type: "haptic", v: BRIDGE_VERSION, kind }),
    onFlip: (orientation) => post({ type: "flip", v: BRIDGE_VERSION, orientation }),
    onClose: () => post({ type: "close", v: BRIDGE_VERSION }),
    onResize: (height) => post({ type: "size", v: BRIDGE_VERSION, height }),
  });

  const receive = (raw: unknown): void => {
    let m: unknown = raw;
    if (typeof raw === "string") {
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!m || typeof m !== "object") return;
    const msg = m as Record<string, unknown>;
    switch (msg.type) {
      case "state":
        state = toBoardState(msg, state);
        view.setState(state);
        break;
      case "settings":
        state = toBoardState({ ...msg, can_move: state.canMove, settings: msg }, state);
        view.setState(state);
        break;
      case "labels":
        // 時計など毎秒変わる文字はこちらで（state を送り直すと送信中の手の表示が消える）。
        state = { ...state, topLabel: str(msg.top_label), bottomLabel: str(msg.bottom_label) };
        view.setLabels(state.topLabel, state.bottomLabel);
        break;
      case "theme":
        state = { ...state, theme: theme(msg.theme) };
        view.setState(state);
        break;
      case "commentary":
        // ビーグルの実況（1 手ごと。数秒遅れて届く）。{ type: "commentary", text, eval_cp, mate, ply, move_label }、
        // text が null なら帯を消す。描き直さないので送信中の手の表示は消えない。
        state = { ...state, commentary: msg.text === null ? null : toBoardCommentary(msg) };
        view.setCommentary(state.commentary);
        break;
      case "flip":
        view.flip();
        break;
      default:
        break;
    }
  };
  // features: この盤が分かる追加の約束（bridge_version は 1 のまま。アプリ・e2e が有無で判断する）。
  (window as W).shogiBoard = { receive, version: BRIDGE_VERSION, features: ["commentary"] };
  window.addEventListener("message", (e: MessageEvent) => {
    // 自分が送ったもの（iframe の親への返事）は無視する。
    const d = e.data as { source?: string } | string;
    if (typeof d === "object" && d && d.source === "bguru-shogi-board") return;
    receive(d);
  });
  window.addEventListener("error", (e) => post({ type: "error", v: BRIDGE_VERSION, message: String(e.message).slice(0, 200) }));
  post({ type: "ready", v: BRIDGE_VERSION });
}

const root = typeof document !== "undefined" ? document.getElementById("board") : null;
if (root) startBridge(root);
