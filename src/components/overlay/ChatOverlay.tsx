"use client";
/* チャットの上に機能を重ねる形（Web、docs/chat-overlay-spec.md）。CHAT_OVERLAY_ENABLED の人だけ（/api/auth/me の chatOverlay）。
 *
 *   OverlaySwitches  2 段目: 🏠 部室・☗ 将棋・🎮 ゲーム・📺 みんなで見る・🍻 オフ会 のスイッチ（出ている機能だけ）＋ ✉️ DM。
 *                    押すと出る・もう一度押すと消える。● は「今動いている」だけ。
 *   OverlayLayer     チャットのログの上に重ねる層: 小さな窓（ドラッグで動かせる）・広げた面（同時に 1 つ）・丸い札。
 *                    📺 は今の浮かぶ窓が小さな窓、広げると上に貼る（docked）。
 * 各機能が出ているかは今までどおり各 store。広げているものと窓の位置は lib/overlay-client.ts。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActionIcon, Button, Text, Tooltip } from "@mantine/core";
import {
  getServerSnapshot,
  getSnapshot,
  forgetExpanded,
  setExpanded,
  setWindowPos,
  subscribe,
  type ActivityId,
} from "@/lib/overlay-client";
import {
  getServerSnapshot as getShogiServer,
  getSnapshot as getShogi,
  loadShogi,
  setShogiOpen,
  subscribe as subscribeShogi,
} from "@/lib/shogi-client";
import {
  getServerSnapshot as getMgServer,
  getSnapshot as getMg,
  loadMinigame,
  setMinigameOpen,
  subscribe as subscribeMg,
} from "@/lib/minigame-client";
import { loadWatch, setWatchMode, setWatchOpen } from "@/lib/watch-client";
import { listen, loadOffkai, setOffkaiOpen, stopAudio } from "@/lib/offkai-client";
import {
  getServerSnapshot as getRoomServer,
  getSnapshot as getRoom,
  loadRoom,
  setRoomView,
  subscribe as subscribeRoom,
} from "@/lib/room-client";
import { ShogiPanel } from "@/components/shogi/ShogiPanel";
import { MinigamePanel } from "@/components/minigame/MinigamePanel";
import { WatchPanel, useWatch } from "@/components/watch/WatchPanel";
import { OffkaiPanel, useOffkai } from "@/components/offkai/OffkaiPanel";
import { DmToggle } from "@/components/dm/DMPanel";
import { RoomOverlayContent } from "@/components/RoomView";

const ORANGE = "#ea580c";
const GREEN = "#15803d";

function useOverlay() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function useShogi() {
  return useSyncExternalStore(subscribeShogi, getShogi, getShogiServer);
}
function useMg() {
  return useSyncExternalStore(subscribeMg, getMg, getMgServer);
}
function useRoomSnap() {
  return useSyncExternalStore(subscribeRoom, getRoom, getRoomServer);
}

/** 各機能の「出ているか」「今動いているか」「札の文」をまとめて読む。 */
function useActivities() {
  const shogi = useShogi();
  const mg = useMg();
  const watch = useWatch();
  const offkai = useOffkai();
  const room = useRoomSnap();
  useEffect(() => {
    if (shogi.status === "unknown") void loadShogi();
    if (mg.status === "unknown") void loadMinigame();
    if (watch.status === "unknown") void loadWatch();
    if (offkai.status === "unknown") void loadOffkai();
    if (room.status === "unknown") void loadRoom();
  }, [shogi.status, mg.status, watch.status, offkai.status, room.status]);
  const game = shogi.games.find((g) => g.status === "active") ?? null;
  const inRoom = room.members.filter((m) => m.mode === "room").length;
  const list: {
    id: ActivityId;
    icon: string;
    label: string;
    available: boolean;
    on: boolean;
    live: boolean;
    chip: string;
  }[] = [
    {
      id: "room",
      icon: "🏠",
      label: "部室",
      available: room.status === "enabled" && !!room.map,
      on: room.view === "room",
      live: inRoom > 0,
      chip: `🏠 部室 ${inRoom}人`,
    },
    {
      id: "shogi",
      icon: "☗",
      label: "将棋",
      available: shogi.status === "enabled",
      on: shogi.open,
      live: !!game,
      chip: game ? `☗ ${game.black?.name ?? ""} vs ${game.white?.name ?? ""} ${game.ply}手` : "☗ 将棋",
    },
    { id: "game", icon: "🎮", label: "ゲーム", available: mg.status === "enabled", on: mg.open, live: false, chip: "🎮 ゲーム" },
    {
      id: "watch",
      icon: "📺",
      label: "みんなで見る",
      available: watch.status === "enabled",
      on: watch.open,
      live: !!watch.state?.video,
      chip: watch.state?.video ? "📺 再生中" : "📺 みんなで見る",
    },
    {
      id: "offkai",
      icon: "🍻",
      label: "オフ会",
      available: offkai.status === "enabled",
      on: offkai.open,
      live: !!offkai.current,
      chip: offkai.current
        ? `🍻 ${offkai.current.speaker?.connected ? `${offkai.current.speaker.name ?? ""} 話し中` : offkai.current.title || "開催中"}`
        : "🍻 オフ会",
    },
  ];
  return { list, shogi, offkai, watch, room, game };
}

function toggle(id: ActivityId, on: boolean): void {
  switch (id) {
    case "room":
      void setRoomView(on ? "text" : "room");
      if (!on) setExpanded("room"); // 部室は地図を見て歩くので、入ったら広げる
      else forgetExpanded("room");
      return;
    case "shogi":
      setShogiOpen(!on);
      if (on) forgetExpanded("shogi");
      return;
    case "game":
      setMinigameOpen(!on);
      if (!on) setExpanded("game"); // 大きくないと遊べない
      else forgetExpanded("game");
      return;
    case "watch":
      if (on) {
        setWatchOpen(false);
        forgetExpanded("watch");
      } else setWatchMode("floating"); // 小さな窓（浮かぶ窓）で出る
      return;
    case "offkai":
      setOffkaiOpen(!on);
      if (on) forgetExpanded("offkai");
      return;
  }
}

export function OverlaySwitches() {
  const { list } = useActivities();
  const shown = list.filter((a) => a.available);
  return (
    <div
      data-cx="overlay-switches"
      style={{ display: "flex", gap: 6, padding: "6px 10px", alignItems: "center", overflowX: "auto", flexShrink: 0, scrollbarWidth: "none" }}
    >
      <style>{`.ovl-name{display:inline}@media (max-width:600px){.ovl-name{display:none}}`}</style>
      {shown.map((a) => (
        <Tooltip key={a.id} label={a.live ? `${a.label}（今動いています）` : a.label} openDelay={400}>
          <button
            type="button"
            aria-pressed={a.on}
            aria-label={a.label}
            data-cx={`overlay-switch-${a.id}`}
            onClick={() => toggle(a.id, a.on)}
            style={{
              position: "relative",
              flexShrink: 0,
              height: 32,
              minWidth: 40,
              padding: "0 10px",
              borderRadius: 999,
              border: `1px solid ${a.on ? GREEN : "var(--border-default, #dbe1dc)"}`,
              background: a.on ? "color-mix(in srgb, #16a34a 15%, var(--bg-surface, #fff))" : "var(--bg-surface, #fff)",
              color: "var(--text-primary, inherit)",
              fontSize: 14,
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              cursor: "pointer",
            }}
          >
            <span aria-hidden>{a.icon}</span>
            <span className="ovl-name">{a.label}</span>
            {a.live && (
              <span aria-hidden style={{ position: "absolute", top: 2, right: 4, width: 8, height: 8, borderRadius: 4, background: ORANGE }} />
            )}
          </button>
        </Tooltip>
      ))}
      <DmToggle />
    </div>
  );
}

/** 部室が無い人（ルームが出ていない）には、今までどおりボイスの帯。部室がある人は 🏠 のスイッチで。 */
export function OverlayVoiceFallback({ fallback }: { fallback: ReactNode }) {
  const room = useRoomSnap();
  useEffect(() => {
    if (room.status === "unknown") void loadRoom();
  }, [room.status]);
  if (room.status === "enabled" && room.map) return null;
  if (room.status === "unknown") return null;
  return <>{fallback}</>;
}

/** 重ねる層。チャットのログを包む position: relative の箱の中に置く。 */
export function OverlayLayer() {
  const ov = useOverlay();
  const { list, shogi, offkai, game } = useActivities();
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 400 });
  useEffect(() => {
    const el = layer.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const watch = useWatch();
  const on = (id: ActivityId) => list.find((a) => a.id === id)?.on ?? false;
  const expanded = ov.expanded && on(ov.expanded) ? ov.expanded : null;

  // 📺: 広げる = 上に貼る（docked）、それ以外は浮かぶ窓。プレイヤーの ⤓（貼る）でも広がった扱いにする。
  useEffect(() => {
    if (!watch.open) return;
    if (watch.mode === "docked" && expanded !== "watch") {
      if (ov.expanded === null) setExpanded("watch");
      else setWatchMode("floating");
    }
  }, [watch.open, watch.mode, expanded, ov.expanded]);
  useEffect(() => {
    if (expanded === "watch" && watch.mode !== "docked") setWatchMode("docked");
  }, [expanded, watch.mode]);

  const minis = list.filter((a) => a.available && a.on && a.id !== expanded && a.id !== "watch" && a.id !== "game");
  const chips = expanded ? list.filter((a) => a.available && a.on && a.id !== expanded) : [];

  const title = list.find((a) => a.id === expanded);
  return (
    <div ref={layer} data-cx="overlay-layer" style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 5 }}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        {/* 広げた面（同時に 1 つ）。📺 のプレイヤーはいつもここにいて、広げていないときは浮かぶ窓になる（iframe を作り直さない）。 */}
        <div
          style={{
            pointerEvents: expanded ? "auto" : "none",
            background: expanded ? "var(--bg-surface, #fff)" : "transparent",
            boxShadow: expanded ? "0 10px 24px rgba(0,0,0,.14)" : "none",
            borderBottom: expanded ? "1px solid var(--border-light, #e7ebe8)" : "none",
            display: "flex",
            flexDirection: "column",
            maxHeight: "62%",
          }}
        >
          {expanded && title && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid var(--border-light, #e7ebe8)" }}>
              <Text size="sm" fw={700} style={{ flex: 1, minWidth: 0 }} truncate>
                {title.chip}
              </Text>
              {chips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setExpanded(c.id)}
                  title="広げる"
                  style={{
                    flexShrink: 0,
                    height: 26,
                    padding: "0 10px",
                    borderRadius: 999,
                    fontSize: 12,
                    border: `1px solid ${c.live ? "#f3d3b6" : "var(--border-default, #dbe1dc)"}`,
                    background: c.live ? "#fff3e8" : "var(--bg-surface, #fff)",
                    color: c.live ? "#9a3412" : "var(--text-primary, inherit)",
                    cursor: "pointer",
                  }}
                >
                  {c.chip}
                </button>
              ))}
              {expanded !== "game" && (
                <ActionIcon variant="subtle" color="gray" aria-label="小さくする" title="小さくする" onClick={() => setExpanded(null)}>
                  ⤡
                </ActionIcon>
              )}
              <ActionIcon variant="subtle" color="gray" aria-label="閉じる" title="閉じる" onClick={() => toggle(expanded, true)}>
                ✕
              </ActionIcon>
            </div>
          )}
          <div style={{ minHeight: 0, overflowY: "auto", position: "relative" }}>
            <WatchPanel />
            {expanded === "shogi" && <ShogiPanel />}
            {expanded === "game" && <MinigamePanel />}
            {expanded === "offkai" && <OffkaiPanel />}
            {expanded === "room" && <RoomOverlayContent />}
          </div>
        </div>
      </div>
      {!expanded &&
        minis.map((a, i) => (
          <MiniWindow key={a.id} id={a.id} size={size} index={i} onExpand={() => setExpanded(a.id)} onClose={() => toggle(a.id, true)}>
            {a.id === "shogi" && (
              <>
                <Text size="sm" fw={700}>
                  {a.chip}
                </Text>
                <Text size="xs" c="dimmed">
                  {game ? (shogi.selectedId === game.id ? "観戦中" : "⤢ で盤を開く") : "⤢ で対局を始める・見る"}
                </Text>
              </>
            )}
            {a.id === "offkai" && (
              <>
                <Text size="sm" fw={700} truncate>
                  🍻 {offkai.current?.title || "オフ会"}
                </Text>
                <Text size="xs" c="dimmed">
                  {offkai.current
                    ? `${offkai.current.speaker?.connected ? `🎙 ${offkai.current.speaker.name ?? ""} 話し中` : "🎙 話している人はいません"} · 🎧${offkai.listeners}`
                    : "開催していません（⤢ で始める・アーカイブ）"}
                </Text>
                {offkai.current && (
                  <Button
                    size="compact-xs"
                    color="orange"
                    variant={offkai.audio === "idle" ? "filled" : "light"}
                    onClick={() => void (offkai.audio === "idle" ? listen() : stopAudio())}
                  >
                    {offkai.audio === "idle" ? "🔊 聞く" : "🔇 止める"}
                  </Button>
                )}
              </>
            )}
            {a.id === "room" && (
              <>
                <Text size="sm" fw={700}>
                  {a.chip}
                </Text>
                <Text size="xs" c="dimmed">
                  ⤢ で地図を開く
                </Text>
              </>
            )}
          </MiniWindow>
        ))}
    </div>
  );
}

/** 小さな窓: ドラッグで動かせる（層の中に収める）。位置は端末に覚える。 */
function MiniWindow({
  id,
  size,
  index,
  onExpand,
  onClose,
  children,
}: {
  id: ActivityId;
  size: { w: number; h: number };
  index: number;
  onExpand: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ov = useOverlay();
  const box = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number; x: number; y: number } | null>(null);
  const W = 220;
  const saved = ov.pos[id];
  const lw = size.w;
  const lh = size.h;
  const H = 110; // 窓のおよその高さ（下にはみ出さない目安）
  const clamp = (x: number, y: number) => ({
    x: Math.max(4, Math.min(x, lw - W - 4)),
    y: Math.max(4, Math.min(y, lh - H - 4)),
  });
  const p = drag ? clamp(drag.x, drag.y) : clamp(saved?.x ?? lw - W - 8, saved?.y ?? 8 + index * 104);
  return (
    <div
      ref={box}
      data-cx={`overlay-mini-${id}`}
      style={{
        position: "absolute",
        left: p.x,
        top: p.y,
        width: W,
        pointerEvents: "auto",
        background: "var(--bg-surface, #fff)",
        border: `1px solid ${id === "offkai" ? "#f3d3b6" : "var(--border-light, #e7ebe8)"}`,
        borderRadius: 14,
        boxShadow: "0 8px 24px rgba(0,0,0,.16)",
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest("button")) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        setDrag({ dx: e.clientX - p.x, dy: e.clientY - p.y, x: p.x, y: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        setDrag({ ...drag, x: e.clientX - drag.dx, y: e.clientY - drag.dy });
      }}
      onPointerUp={() => {
        if (!drag) return;
        const q = clamp(drag.x, drag.y);
        setWindowPos(id, q.x, q.y);
        setDrag(null);
      }}
    >
      <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 2 }}>
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label="広げる" title="広げる" onClick={onExpand}>
          ⤢
        </ActionIcon>
        <ActionIcon size="sm" variant="subtle" color="gray" aria-label="閉じる" title="閉じる" onClick={onClose}>
          ✕
        </ActionIcon>
      </div>
      <div style={{ paddingRight: 48, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>{children}</div>
    </div>
  );
}
