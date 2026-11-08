/* 将棋・散財ダッシュを「大きく表示」（rbtnn さん 2026-11-08「将棋と散財ダッシュを部室と同じくらいの大きさに」）。
 * どちらを大きくしているか（同時に 1 つ）。Esc で戻る。 */
import { useEffect, useSyncExternalStore } from "react";

export type BigViewId = "shogi" | "game";
let current: BigViewId | null = null;
const listeners = new Set<() => void>();

export function setBigView(id: BigViewId | null): void {
  if (current === id) return;
  current = id;
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useBigView(id: BigViewId): boolean {
  const big = useSyncExternalStore(subscribe, () => current === id, () => false);
  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "Escape" || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
      setBigView(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [big]);
  return big;
}

/** 大きな窓の置き場所（部室の大きな表示と同じ）: 上はヘッダー、下はチャットの入力欄を残す。 */
export const BIG_VIEW_STYLE: React.CSSProperties = {
  position: "fixed",
  top: 56,
  bottom: 84,
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(1180px, calc(100vw - 24px))",
  zIndex: 300,
  background: "var(--bg-surface, #fff)",
  border: "1px solid var(--border-default, #dbe1dc)",
  borderRadius: 10,
  boxShadow: "0 16px 40px rgba(0, 0, 0, 0.35)",
  overflow: "hidden",
};

/** 大きな窓の中で使える高さ（px）。 */
export function bigViewHeight(): number {
  return typeof window === "undefined" ? 600 : Math.max(300, window.innerHeight - 56 - 84);
}
