"use client";
/* 📺 YouTube 共同鑑賞（Web）。☗・🎮 の並びに「📺」、開くとチャットの上にプレイヤー（docked）。
 * 「⧉」で浮かぶ窓（floating: 上の帯でドラッグ、右下の角で大きさ変更、⤓ で戻す）。
 *
 *   WatchToggle   「📺」（WATCH_ENABLED で出していない人には出さない）
 *   WatchPanel    プレイヤーのページ（public/watch/。アプリの WebView と同じ）を同じ iframe のまま docked / floating で出す
 * 状態は lib/watch-client.ts（React の外）。☗・🎮 を開いたら、docked のプレイヤーは浮かぶ窓へ移る（止めない）。 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Tooltip } from "@mantine/core";
import {
  getServerSnapshot,
  getSnapshot,
  loadWatch,
  setWatchMode,
  setWatchOpen,
  subscribe,
  watchAction,
  watchTogether,
  type WatchSnapshot,
} from "@/lib/watch-client";
import {
  getSnapshot as getShogiSnapshot,
  subscribe as subscribeShogi,
} from "@/lib/shogi-client";
import {
  getSnapshot as getMinigameSnapshot,
  subscribe as subscribeMinigame,
} from "@/lib/minigame-client";

export function useWatch(): WatchSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function WatchToggle() {
  const s = useWatch();
  useEffect(() => {
    if (s.status === "unknown") void loadWatch();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  const playing = !!s.state?.video;
  return (
    <Tooltip
      label={
        playing
          ? `みんなで見ている: ${s.state?.video?.title ?? ""}`
          : "みんなで見る（YouTube）"
      }
      openDelay={400}
    >
      <ActionIcon
        size="md"
        variant={s.open ? "filled" : "light"}
        color={playing && !s.open ? "red" : "green"}
        aria-label="みんなで見る"
        title="みんなで見る"
        aria-pressed={s.open}
        data-cx="watch-toggle"
        onClick={() => setWatchOpen(!s.open)}
      >
        <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
          📺
        </span>
      </ActionIcon>
    </Tooltip>
  );
}

type Rect = { x: number; y: number; w: number; h: number };
const FLOAT_KEY = "bguru.watch.float";
const BAR_H = 28;

function loadRect(): Rect {
  const vw = typeof window === "undefined" ? 1200 : window.innerWidth;
  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const w = Math.min(520, vw - 24);
  const h = Math.round((w * 9) / 16) + 44 + BAR_H;
  let r: Rect = { x: vw - w - 16, y: vh - h - 16, w, h };
  try {
    const saved = JSON.parse(
      localStorage.getItem(FLOAT_KEY) ?? "null",
    ) as Rect | null;
    if (
      saved &&
      [saved.x, saved.y, saved.w, saved.h].every((n) => Number.isFinite(n))
    )
      r = saved;
  } catch {
    /* 覚えていなくても出せる */
  }
  return fit(r);
}

/** 画面の中に収める（窓を小さくしたとき・別の画面で開いたとき）。 */
function fit(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(240, Math.min(r.w, vw - 8));
  const h = Math.max(150, Math.min(r.h, vh - 8));
  return {
    w,
    h,
    x: Math.max(4, Math.min(r.x, vw - w - 4)),
    y: Math.max(4, Math.min(r.y, vh - h - 4)),
  };
}

/** docked の高さ: チャット欄の高さの半分まで（残りでチャットが見える）。 */
function useDockHeight(
  ref: React.RefObject<HTMLDivElement | null>,
  on: boolean,
): number {
  const [h, setH] = useState(320);
  useEffect(() => {
    const el = ref.current;
    const col = el?.parentElement;
    if (!on || !el || !col || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const byWidth = Math.round((el.clientWidth * 9) / 16) + 44 + 150; // 絵 + 帯 + URL・リストを少し
      setH(
        Math.round(Math.max(200, Math.min(byWidth, col.clientHeight * 0.5))),
      );
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(col);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, on]);
  return h;
}

export function WatchPanel() {
  const s = useWatch();
  const on = s.status === "enabled" && s.open;
  const floating = s.mode === "floating";
  const shogiOpen = useSyncExternalStore(
    subscribeShogi,
    () => getShogiSnapshot().open,
    () => false,
  );
  const gameOpen = useSyncExternalStore(
    subscribeMinigame,
    () => getMinigameSnapshot().open,
    () => false,
  );
  const frame = useRef<HTMLIFrameElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const ready = useRef(false);
  const [placed, setRect] = useState<Rect | null>(null);
  const [moving, setMoving] = useState(false);
  const dockH = useDockHeight(box, on && !floating);

  // ☗・🎮 を開いたら、docked のプレイヤーは浮かぶ窓へ（2 つ重ねるとチャットが見えない。動画は止めない）。
  useEffect(() => {
    if (
      (shogiOpen || gameOpen) &&
      getSnapshot().open &&
      getSnapshot().mode === "docked"
    )
      setWatchMode("floating");
  }, [shogiOpen, gameOpen]);

  // 浮かぶ窓の場所: 動かしたらそれ、まだなら前に覚えた場所（なければ右下）。
  const rect = floating ? (placed ?? (typeof window !== "undefined" ? loadRect() : null)) : null;
  useEffect(() => {
    if (!floating) return;
    const onResize = () => setRect((r) => fit(r ?? loadRect()));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [floating]);

  const toPage = (msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(
      { ...msg, source: "bguru-watch-host" },
      window.location.origin,
    );
  };
  const compact =
    floating &&
    !!rect &&
    rect.h < Math.round((rect.w * 9) / 16) + 44 + BAR_H + 120;

  // ページからの知らせ（同じ置き場所・この iframe からだけ）。
  useEffect(() => {
    if (!on) return;
    const onMsg = (e: MessageEvent) => {
      if (
        e.origin !== window.location.origin ||
        e.source !== frame.current?.contentWindow
      )
        return;
      const d = e.data as {
        source?: string;
        type?: string;
        body?: Record<string, unknown>;
      } | null;
      if (!d || d.source !== "bguru-watch") return;
      if (d.type === "ready") {
        ready.current = true;
        toPage({
          type: "hello",
          bridge: 1,
          platform: "web",
          can_control: true,
          compact,
        });
        const st = getSnapshot().state;
        if (st) toPage({ type: "state", state: st });
      } else if (d.type === "action" && d.body) {
        void watchAction(d.body);
      } else if (d.type === "popout") {
        setWatchMode(getSnapshot().mode === "floating" ? "docked" : "floating");
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
    // compact は下の effect で送る
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  useEffect(() => {
    if (!on) ready.current = false;
  }, [on]);
  useEffect(() => {
    if (ready.current && s.state) toPage({ type: "state", state: s.state });
  }, [s.state]);
  useEffect(() => {
    if (ready.current && s.error)
      toPage({ type: "error", message: s.error.message });
  }, [s.error]);
  useEffect(() => {
    if (ready.current) toPage({ type: "layout", compact });
  }, [compact]);

  const save = (r: Rect) => {
    try {
      localStorage.setItem(FLOAT_KEY, JSON.stringify(r));
    } catch {
      /* 覚えられなくても動く */
    }
  };

  /** 上の帯でドラッグ / 右下の角で大きさ変更。動かしている間は iframe がポインタを取らないようにする。 */
  const drag = (kind: "move" | "size") => (e: React.PointerEvent) => {
    if (!rect) return;
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, r: rect };
    setMoving(true);
    let last = rect;
    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      last = fit(
        kind === "move"
          ? { ...start.r, x: start.r.x + dx, y: start.r.y + dy }
          : { ...start.r, w: start.r.w + dx, h: start.r.h + dy },
      );
      setRect(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setMoving(false);
      save(last);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  if (!on) return null;
  const style: React.CSSProperties =
    floating && rect
      ? {
          position: "fixed",
          left: rect.x,
          top: rect.y,
          width: rect.w,
          height: rect.h,
          zIndex: 400,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 12px 32px rgba(0,0,0,.28)",
          border: "1px solid var(--mantine-color-default-border)",
          background: "var(--mantine-color-body)",
          display: "flex",
          flexDirection: "column",
        }
      : {
          height: dockH,
          flex: "0 0 auto",
          borderBottom:
            "1px solid var(--border-green-soft, var(--mantine-color-default-border))",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        };
  return (
    <div
      ref={box}
      data-cx="watch-panel"
      data-mode={floating ? "floating" : "docked"}
      style={style}
    >
      <div
        onPointerDown={floating ? drag("move") : undefined}
        style={{
          display: floating ? "flex" : "none",
          height: BAR_H,
          flex: "0 0 auto",
          alignItems: "center",
          gap: 6,
          padding: "0 6px 0 10px",
          cursor: "grab",
          userSelect: "none",
          fontSize: 12,
          fontWeight: 600,
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <span
          style={{
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          📺 {s.state?.video?.title ?? "みんなで見る"}
        </span>
        <ActionIcon
          size="sm"
          variant="subtle"
          aria-label="チャットの上に戻す"
          title="チャットの上に戻す"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setWatchMode("docked")}
        >
          ⤓
        </ActionIcon>
        <ActionIcon
          size="sm"
          variant="subtle"
          aria-label="閉じる"
          title="閉じる（動画はみんなの方で続きます）"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setWatchOpen(false)}
        >
          ✕
        </ActionIcon>
      </div>
      <iframe
        ref={frame}
        src="/watch/index.html"
        title="みんなで見る（YouTube）"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
        style={{
          border: 0,
          width: "100%",
          flex: "1 1 auto",
          minHeight: 0,
          pointerEvents: moving ? "none" : "auto",
        }}
      />
      {floating && (
        <div
          onPointerDown={drag("size")}
          aria-hidden
          style={{
            position: "absolute",
            right: 0,
            bottom: 0,
            width: 18,
            height: 18,
            cursor: "nwse-resize",
            zIndex: 2,
          }}
        />
      )}
    </div>
  );
}

/** YouTube のリンク（タイムラインのカード・チャット）の「📺 みんなで見る」。使えない人には出さない。 */
export function WatchTogetherButton({
  url,
  compact = false,
}: {
  url: string;
  compact?: boolean;
}) {
  const s = useWatch();
  useEffect(() => {
    if (s.status === "unknown") void loadWatch();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  const busy = !!s.state?.video;
  const label = busy ? "📺 見たいものリストへ" : "📺 みんなで見る";
  return (
    <button
      type="button"
      data-cx="watch-together"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void watchTogether(url);
      }}
      title={
        busy ? "いま流れている動画の次に見る" : "チャットのみんなと同時に見る"
      }
      style={{
        marginTop: compact ? 4 : 8,
        border: "1px solid var(--mantine-color-default-border)",
        background: "var(--mantine-color-body)",
        color: "inherit",
        borderRadius: 999,
        padding: compact ? "2px 10px" : "4px 12px",
        fontSize: compact ? 12 : 13,
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
