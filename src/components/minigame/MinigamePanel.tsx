"use client";
/* 🎮 散財ダッシュ（Web）。チャットの上の「テキスト｜ルーム｜☗」の隣に「🎮」、開くと上にゲーム・下にチャット。
 *
 *   GameToggles     ☗ と 🎮 のボタン（どちらも出していない人には何も出さない。ルームが無いときは 1 行に並べる）
 *   MinigameToggle  「🎮」（アイコンだけ。ラベル「ゲーム」。MINIGAME_ENABLED で出していない人には出さない）
 *   MinigamePanel   ゲームの部品（lib/minigame/game.ts。アプリの WebView と同じ）。開いている間だけ作り、閉じたら捨てる。
 * 状態は lib/minigame-client.ts（React の外）。 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Tooltip, useComputedColorScheme } from "@mantine/core";
import type { DashGame } from "@/lib/minigame/game";
import {
  WebHost,
  getServerSnapshot,
  getSnapshot,
  loadMinigame,
  setMinigameOpen,
  subscribe,
  type MinigameSnapshot,
} from "@/lib/minigame-client";
import { ShogiToggle } from "@/components/shogi/ShogiPanel";
import {
  getServerSnapshot as getShogiServerSnapshot,
  getSnapshot as getShogiSnapshot,
  subscribe as subscribeShogi,
} from "@/lib/shogi-client";

function useMinigame(): MinigameSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function MinigameToggle() {
  const s = useMinigame();
  useEffect(() => {
    if (s.status === "unknown") void loadMinigame();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  return (
    <Tooltip label="ゲーム（散財ダッシュ）" openDelay={400}>
      <ActionIcon
        size="md"
        variant={s.open ? "filled" : "light"}
        color="green"
        aria-label="ゲーム"
        title="ゲーム"
        aria-pressed={s.open}
        data-cx="minigame-toggle"
        onClick={() => setMinigameOpen(!s.open)}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
          🎮
        </span>
      </ActionIcon>
    </Tooltip>
  );
}

/** ☗ と 🎮 を並べる。row = ルームが無いとき（自分の行に置く）。 */
export function GameToggles({ row = false }: { row?: boolean }) {
  const mg = useMinigame();
  const shogi = useSyncExternalStore(subscribeShogi, getShogiSnapshot, getShogiServerSnapshot);
  useEffect(() => {
    if (mg.status === "unknown") void loadMinigame();
  }, [mg.status]);
  const items = (
    <>
      <ShogiToggle />
      <MinigameToggle />
    </>
  );
  if (!row) return <div style={{ display: "flex", gap: 6, alignItems: "center" }}>{items}</div>;
  if (mg.status !== "enabled" && shogi.status !== "enabled") {
    // 読み込み中・どちらも無い: 行を取らない（ただしボタンの読み込みは走らせる）
    return <div style={{ display: "none" }}>{items}</div>;
  }
  return <div style={{ padding: "6px 10px 0", display: "flex", gap: 6, alignItems: "center" }}>{items}</div>;
}

/** ゲームの高さの上限: チャット欄の高さの約 45%（残りでチャットが見える。将棋と同じ考え方）。 */
function usePanelMax(ref: React.RefObject<HTMLDivElement | null>, on: boolean): number {
  const [max, setMax] = useState(260);
  useEffect(() => {
    const col = ref.current?.parentElement;
    if (!on || !col || typeof ResizeObserver === "undefined") return;
    const update = () => setMax(Math.round(Math.max(150, Math.min(420, col.clientHeight * 0.45))));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(col);
    return () => ro.disconnect();
  }, [ref, on]);
  return max;
}

export function MinigamePanel() {
  const s = useMinigame();
  const shogiOpen = useSyncExternalStore(subscribeShogi, () => getShogiSnapshot().open, () => false);
  const ref = useRef<HTMLDivElement>(null);
  const on = s.status === "enabled" && s.open;
  const max = usePanelMax(ref, on);
  // ☗ を開いたらこちらは閉じる（2 つ重ねない）。
  useEffect(() => {
    if (shogiOpen && getSnapshot().open) setMinigameOpen(false);
  }, [shogiOpen]);
  if (!on) return null;
  return (
    <div
      ref={ref}
      data-cx="minigame-panel"
      style={{
        borderBottom: "1px solid var(--border-green-soft, var(--mantine-color-default-border))",
        padding: "6px 8px",
        flex: "0 0 auto",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      <GameView s={s} maxHeight={max - 12} />
    </div>
  );
}

function GameView({ s, maxHeight }: { s: MinigameSnapshot; maxHeight: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const game = useRef<DashGame | null>(null);
  const scheme = useComputedColorScheme("light");
  const maxRef = useRef(maxHeight);
  useEffect(() => {
    maxRef.current = maxHeight;
  }, [maxHeight]);
  useEffect(() => {
    let g: DashGame | null = null;
    let cancelled = false;
    // ゲームの部品（描画・ドット絵）は開いたときに読み込む（main の束を重くしない）。
    void import("@/lib/minigame/game").then(({ DashGame }) => {
      if (cancelled || !ref.current) return;
      g = new DashGame(ref.current, new WebHost(), { theme: scheme, maxHeight: maxRef.current });
      game.current = g;
      const snapNow = getSnapshot();
      if (snapNow.info) g.setInfo(snapNow.info);
      if (snapNow.topToday) g.setTopToday(snapNow.topToday);
    });
    return () => {
      cancelled = true;
      g?.destroy();
      game.current = null;
    };
    // 作るのは 1 回だけ（大きさ・テーマ・情報は下の effect で渡す）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (s.info) game.current?.setInfo(s.info);
  }, [s.info]);
  useEffect(() => {
    if (s.topToday) game.current?.setTopToday(s.topToday);
  }, [s.topToday]);
  useEffect(() => {
    game.current?.setMaxHeight(maxHeight);
  }, [maxHeight]);
  useEffect(() => {
    game.current?.setTheme(scheme);
  }, [scheme]);
  return <div ref={ref} style={{ width: "100%" }} />;
}

