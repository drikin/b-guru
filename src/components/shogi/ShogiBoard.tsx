"use client";
/* ☗ 将棋の盤（React の包み）。中身は lib/shogi-board/board.ts の ShogiBoardView（アプリの WebView と同じ部品）。 */
import { useEffect, useLayoutEffect, useRef } from "react";
import { ShogiBoardView, type BoardState, type Haptic } from "@/lib/shogi-board/board";
import type { Side } from "@/lib/shogi-rules";

export default function ShogiBoard(
  props: BoardState & {
    onMove?: (usi: string, label: string) => void;
    onFlip?: (o: Side) => void;
  }
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const view = useRef<ShogiBoardView | null>(null);
  const cbs = useRef(props);
  useLayoutEffect(() => {
    cbs.current = props;
  });

  useEffect(() => {
    if (!ref.current) return;
    const v = new ShogiBoardView(ref.current, cbs.current, {
      onMove: (usi, label) => cbs.current.onMove?.(usi, label),
      onFlip: (o) => cbs.current.onFlip?.(o),
      onHaptic: (k: Haptic) => {
        // 振動できる端末（Android の Chrome）だけ。iPhone の Safari は何もしない。
        try {
          if (k !== "select") navigator.vibrate?.(k === "error" ? [20, 40, 20] : 15);
        } catch {
          /* not allowed */
        }
      },
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
  }, []);

  const {
    sfen,
    myColor,
    orientation,
    lastMove,
    canMove,
    legalMoves,
    settings,
    compact,
    maxHeight,
    theme,
    topLabel,
    bottomLabel,
    showClose,
  } = props;
  useEffect(() => {
    view.current?.setState({
      sfen,
      myColor,
      orientation,
      lastMove,
      canMove,
      legalMoves,
      settings,
      compact,
      maxHeight,
      theme,
      topLabel: cbs.current.topLabel,
      bottomLabel: cbs.current.bottomLabel,
      showClose,
      commentary: cbs.current.commentary,
    });
    // settings はオブジェクト: 中身で比べる。名前・時計の文字は下の setLabels で（毎秒描き直さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sfen, myColor, orientation, lastMove?.usi, lastMove?.label, canMove, legalMoves, settings?.confirmMove, settings?.moveHints, compact, maxHeight, theme, showClose]);

  useEffect(() => {
    view.current?.setLabels(topLabel, bottomLabel);
  }, [topLabel, bottomLabel]);

  // ビーグルの実況の帯（数秒遅れて届く。描き直さずに帯だけ変える）。
  const c = props.commentary ?? null;
  useEffect(() => {
    view.current?.setCommentary(cbs.current.commentary ?? null);
    // 中身で比べる（毎回新しいオブジェクトでも描き直さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!c, c?.text, c?.evalCp, c?.mate, c?.ply, c?.moveLabel]);

  return <div ref={ref} style={{ width: "100%" }} />;
}
