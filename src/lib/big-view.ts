/* 「大きく表示」（部室・将棋・散財ダッシュ。rbtnn さん 2026-11-08「将棋と散財ダッシュを部室と同じくらいの大きさに」）。
 * 同時に 1 つだけ。Esc で戻る（散財ダッシュは遊んでいる最中の Esc が一時停止なので、Esc では閉じない）。
 * 窓はページ直下に出す（チャットの上に重ねる層の重なり順の中だと、左のメニューや上のタブの下に隠れる）。
 * 中身を作り直さないよう、描く先は「いつも同じ入れ物」にし、その入れ物の DOM だけを動かす（qa-engineer 2026-11-08:
 * 作り直すと遊んでいる途中の回・盤の状態が消えていた）。 */
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";

export type BigViewId = "room" | "shogi" | "game";
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

/** この id が大きく表示されているか。esc=false なら Esc では閉じない。窓の大きさが変わったら描き直す。 */
export function useBigView(id: BigViewId, esc = true): boolean {
  const big = useSyncExternalStore(subscribe, () => current === id, () => false);
  const [, bump] = useState(0);
  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!esc || e.key !== "Escape" || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))) return;
      setBigView(null);
    };
    const resize = () => bump((n) => n + 1);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", resize);
    };
  }, [big, esc]);
  return big;
}

const TOP = "max(56px, calc(env(safe-area-inset-top, 0px) + 48px))";
const BOTTOM = "max(84px, calc(env(safe-area-inset-bottom, 0px) + 76px))";

/** 大きな窓の置き場所（部室の大きな表示と同じ）: 上はヘッダー、下はチャットの入力欄を残す。 */
export const BIG_VIEW_STYLE: React.CSSProperties = {
  position: "fixed",
  top: TOP,
  bottom: BOTTOM,
  left: "50%",
  transform: "translateX(-50%)",
  width: "min(1180px, calc(100vw - 24px))",
  zIndex: 300,
  background: "var(--bg-surface, #fff)",
  border: "1px solid var(--border-default, #dbe1dc)",
  borderRadius: 10,
  boxShadow: "0 16px 40px rgba(0, 0, 0, 0.35)",
  overflow: "hidden",
  boxSizing: "border-box",
};

/** 大きな窓の中で使える高さ（px）。上下の余白（56 + 84）を引いた残り。横向きのスマホでも窓からはみ出さない。 */
export function bigViewHeight(): number {
  return typeof window === "undefined" ? 600 : Math.max(160, window.innerHeight - 56 - 84 - 2);
}

/** いつも同じ入れ物に描くための仕掛け。slot は小さいときの置き場所。big のとき入れ物をページ直下へ動かす。 */
export function useBigHost(big: boolean): { host: HTMLDivElement | null; slot: (el: HTMLDivElement | null) => void; slotEl: HTMLDivElement | null } {
  const [host] = useState(() => (typeof document === "undefined" ? null : document.createElement("div")));
  const [slotEl, slot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!host) return;
    if (big) {
      host.removeAttribute("style");
      Object.assign(host.style, {
        position: "fixed",
        top: TOP,
        bottom: BOTTOM,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(1180px, calc(100vw - 24px))",
        zIndex: "300",
        background: "var(--bg-surface, #fff)",
        border: "1px solid var(--border-default, #dbe1dc)",
        borderRadius: "10px",
        boxShadow: "0 16px 40px rgba(0, 0, 0, 0.35)",
        overflow: "hidden",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
      } satisfies Partial<CSSStyleDeclaration>);
      document.body.appendChild(host);
    } else {
      host.removeAttribute("style");
      if (slotEl) slotEl.appendChild(host);
    }
  }, [big, host, slotEl]);
  useEffect(() => () => host?.remove(), [host]);
  return { host, slot, slotEl };
}
