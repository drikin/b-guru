"use client";
/* The club room (ルーム) in the chat column.
 *
 *   RoomPanel — goes where the voice bar was. Room off (GET /api/room → 404):
 *     renders `fallback` (the old VoiceBar), nothing else changes. Room on:
 *     a 「テキスト｜ルーム」 switch; テキスト shows the "ルームへ" banner, ルーム
 *     shows the pixel map (above the chat log and composer) with 🎧/👀, 🎙,
 *     the zone, reactions, tap-a-person, D-pad (touch only), arrows / WASD.
 *
 * State lives in lib/room-client.ts (outside React); the map draws the animated
 * actors from there every frame. Voice proximity is applied by the store. */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Avatar, Button, CloseButton, Group, Popover, SegmentedControl, Text, Tooltip, UnstyledButton } from "@mantine/core";
import {
  clearRoomNotice,
  getActors,
  getServerSnapshot,
  getSnapshot,
  loadRoom,
  myMember,
  pressDir,
  releaseDir,
  sendReaction,
  setListening,
  setRoomMic,
  setRoomView,
  subscribe,
  tickRoom,
  walkTo,
  type RoomSnapshot,
} from "@/lib/room-client";
import {
  getServerSnapshot as getVoiceServerSnapshot,
  getSnapshot as getVoiceSnapshot,
  loadVoice,
  micActive,
  setVoiceNotice,
  subscribe as subscribeVoice,
  unlockAudio,
  voiceLoaded,
  type VoiceSnapshot,
} from "@/lib/voice-client";
import { lookFor, statusMark, tileOf, volumeFor, voiceCounts, zoneOf, type Dir, type Look, type RoomMapDto, type RoomMember } from "@/lib/room-logic";
import { ROOM_BG, ROOM_COLORS, TILE, drawBeagle, drawBubble, drawEmoji, drawLabel, drawPerson, renderBase } from "./room-draw";
import css from "./RoomView.module.css";

const GREEN = "var(--text-green, #2b8a3e)";

function useRoom(): RoomSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(subscribeVoice, getVoiceSnapshot, getVoiceServerSnapshot);
}

/** LiveKit identities talking now (me: my own level meter). */
function speakingIds(v: VoiceSnapshot, me: string | null): Set<string> {
  const out = new Set(v.members.filter((m) => m.speaking).map((m) => m.userId));
  if (me && micActive(v)) out.add(me);
  return out;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export default function RoomPanel({ fallback }: { fallback: ReactNode }) {
  const s = useRoom();
  useEffect(() => {
    if (s.status === "unknown") void loadRoom();
    if (!voiceLoaded()) void loadVoice();
  }, [s.status]);
  if (s.status !== "enabled" || !s.map) return <>{fallback}</>;
  return <RoomChrome s={s} />;
}

function RoomChrome({ s }: { s: RoomSnapshot }) {
  const v = useVoice();
  const speaking = useMemo(() => speakingIds(v, s.me), [v, s.me]);
  const me = myMember(s);
  const inRoom = s.view === "room";
  const notice = s.notice ?? (inRoom ? v.notice : null);
  return (
    <>
      <div
        style={{
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-green-soft, var(--mantine-color-default-border))",
          display: "flex",
          flexDirection: "column",
          gap: 6,
        }}
      >
        <Group gap={6} wrap="wrap" justify="space-between">
          <SegmentedControl
            size="xs"
            radius="md"
            color="green"
            value={s.view}
            disabled={s.busy}
            onChange={(val) => void setRoomView(val as "text" | "room")}
            data={[
              { value: "text", label: "テキスト" },
              { value: "room", label: "ルーム" },
            ]}
            aria-label="表示の切り替え"
          />
          {inRoom && <RoomControls s={s} v={v} me={me} speaking={speaking} />}
        </Group>
        {!inRoom && <EnterBanner s={s} speaking={speaking} connected={v.phase !== "idle"} />}
        {inRoom && v.needsAudioUnlock && (
          <Button size="compact-xs" variant="light" color="green" onClick={() => void unlockAudio()}>
            🔈 クリックして音を出す
          </Button>
        )}
        {notice && (
          <Group gap={4} wrap="nowrap" align="flex-start">
            <Text size="xs" c="red" style={{ flex: 1 }} role="status">
              {notice}
            </Text>
            <CloseButton
              size="xs"
              aria-label="閉じる"
              onClick={() => {
                clearRoomNotice();
                setVoiceNotice(null);
              }}
            />
          </Group>
        )}
      </div>
      {inRoom && <RoomMap s={s} speaking={speaking} />}
    </>
  );
}

function RoomControls({ s, v, me, speaking }: { s: RoomSnapshot; v: VoiceSnapshot; me: RoomMember | null; speaking: Set<string> }) {
  const listening = me?.mode === "room" ? me.listening : s.wantListening;
  const connected = v.phase === "connected" || v.phase === "reconnecting";
  const micOn = v.micOn;
  const active = micActive(v);
  return (
    <Group gap={6} wrap="nowrap">
      <Tooltip label={listening ? "見るだけにする（音を出さない）" : "近くの人の声を聞く"} openDelay={400}>
        <Button
          size="compact-sm"
          variant={listening ? "light" : "default"}
          color="green"
          disabled={s.busy}
          aria-pressed={listening}
          onClick={() => void setListening(!listening)}
        >
          {listening ? "🎧 聞いている" : "👀 見るだけ"}
        </Button>
      </Tooltip>
      <Tooltip label={!listening ? "見るだけの間はマイクを使えません" : micOn ? "マイクを切る" : "マイクをオンにして話す"} openDelay={400}>
        <Button
          size="compact-sm"
          variant={micOn ? "filled" : "default"}
          color="green"
          disabled={!listening || !connected || v.micBusy}
          aria-pressed={micOn}
          loading={v.micBusy}
          onClick={() => void setRoomMic(!micOn)}
          style={{
            outline: active ? `3px solid color-mix(in srgb, ${GREEN} 40%, transparent)` : "none",
            outlineOffset: active ? 1 + Math.round(v.micLevel * 3) : 0,
          }}
        >
          🎙 {micOn ? "オン" : "オフ"}
        </Button>
      </Tooltip>
      <HearPopover s={s} me={me} speaking={speaking} />
    </Group>
  );
}

/** Who I can hear, and how loud (a popover; small on phones). */
function HearPopover({ s, me, speaking }: { s: RoomSnapshot; me: RoomMember | null; speaking: Set<string> }) {
  const list = s.members
    .filter((m) => m.userId !== s.me)
    .map((m) => ({ m, v: me?.listening ? volumeFor(me, m) : 0 }))
    .filter((o) => o.v > 0)
    .sort((a, b) => b.v - a.v);
  const zone = me && s.map ? zoneOf(s.map.zones, me.x, me.y) : null;
  const rule =
    zone?.kind === "table"
      ? "テーブルの中の人とだけ話せます（外には聞こえません）"
      : zone?.kind === "stage"
        ? "ステージの声は部室の全員に届きます"
        : `まわり ${s.map?.hear_radius ?? 4} マスの人の声が聞こえます。離れるほど小さく、ステージの声は全員に届きます。`;
  return (
    <Popover position="bottom-end" withinPortal shadow="md" width={260}>
      <Popover.Target>
        <Button size="compact-sm" variant="subtle" color="gray" aria-label="聞こえている人">
          👂 {list.length}
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Text size="xs" fw={700} mb={4}>
          聞こえている人
        </Text>
        {list.length === 0 ? (
          <Text size="xs" c="dimmed">
            {me?.listening ? "近くに誰もいません。誰かのそばへ歩いてみてください。" : "見るだけにしています。"}
          </Text>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {list.map(({ m, v }) => (
              <div key={m.userId} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                <span style={{ width: 90, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {speaking.has(m.userId) ? "🔊 " : ""}
                  {m.name}
                </span>
                <span className={css.bar}>
                  <i style={{ width: `${Math.round(v * 100)}%` }} />
                </span>
                <span style={{ width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--mantine-color-dimmed)" }}>
                  {Math.round(v * 100)}%
                </span>
              </div>
            ))}
          </div>
        )}
        <Text size="xs" c="dimmed" mt={8}>
          {rule}
        </Text>
        <Text size="xs" c="dimmed" mt={4}>
          ⌨️ テキスト　🎧 聞いている　🔊 話している　👀 見るだけ　💤 離席
        </Text>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Text view: 「🎧 部室で N 人がボイスに入っています（M 人が話し中）［ルームへ ▶］」. */
function EnterBanner({ s, speaking, connected }: { s: RoomSnapshot; speaking: Set<string>; connected: boolean }) {
  const { inVoice, talking } = voiceCounts(s.members, speaking);
  const here = s.members.length;
  return (
    <UnstyledButton
      onClick={() => void setRoomView("room")}
      disabled={s.busy}
      aria-label="ルームへ入る"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        borderRadius: 10,
        border: `1px solid ${GREEN}`,
        background: `color-mix(in srgb, ${GREEN} 8%, transparent)`,
      }}
    >
      {inVoice.length > 0 && (
        <Avatar.Group spacing={6}>
          {inVoice.slice(0, 5).map((m) => (
            <Avatar key={m.userId} src={m.avatar || undefined} size={24} radius="xl" color="green" title={m.name}>
              {m.name.charAt(0).toUpperCase()}
            </Avatar>
          ))}
        </Avatar.Group>
      )}
      <span style={{ flex: 1, minWidth: 0, fontSize: 13, lineHeight: 1.4 }}>
        {inVoice.length > 0 ? (
          <>
            🎧 部室で <b>{inVoice.length} 人</b>がボイスに入っています
            {connected && talking > 0 ? `（${talking} 人が話し中）` : ""}
          </>
        ) : (
          <>🏠 部室に {here} 人（ボイスにはまだ誰もいません）</>
        )}
        <Text component="span" size="xs" c="dimmed" display="block">
          入るとマイクはオフのまま、近くの人の声が聞こえます
        </Text>
      </span>
      <span style={{ color: GREEN, fontWeight: 700, whiteSpace: "nowrap", fontSize: 13 }}>ルームへ ▶</span>
    </UnstyledButton>
  );
}

// ---- the map ----

interface BeagleState {
  x: number;
  y: number;
  fx: number;
  frame: number;
  flip: boolean;
  bubbleUntil: number;
  t: number;
  minX: number;
  maxX: number;
}

/** One frame of the map: floor, hearing range, labels, beagle, people, bubbles, reactions. */
function drawRoom(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  map: RoomMapDto,
  base: HTMLCanvasElement,
  v: { zoom: number; camX: number; camY: number },
  st: RoomSnapshot,
  sp: Set<string>,
  rm: boolean,
  now: number,
  beagle: BeagleState
) {
  const zoom = v.zoom;
  const W = map.w * TILE;
  const H = map.h * TILE;
  const actors = getActors();
  const meA = actors.get(st.me ?? "");
  const meM = myMember(st);
  const vw = canvas.width / zoom;
  const vh = canvas.height / zoom;
  const fx = meA ? meA.fx : map.w / 2;
  const fy = meA ? meA.fy : map.h / 2;
  const cx = (fx + 0.5) * TILE - vw / 2;
  const cy = (fy + 0.5) * TILE - vh / 2;
  v.camX = Math.round(Math.max(Math.min(cx, W - vw), Math.min(0, (W - vw) / 2)));
  v.camY = Math.round(Math.max(Math.min(cy, H - vh), Math.min(0, (H - vh) / 2)));
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = ROOM_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(zoom, 0, 0, zoom, -v.camX * zoom, -v.camY * zoom);
  ctx.drawImage(base, 0, 0);

  // Hearing range around me (outside the zones).
  if (meA && meM?.mode === "room" && meM.listening && !zoneOf(map.zones, meM.x, meM.y)) {
    ctx.fillStyle = "rgba(60,207,116,.08)";
    ctx.strokeStyle = "rgba(60,207,116,.45)";
    ctx.lineWidth = 2 / zoom;
    ctx.beginPath();
    ctx.arc((meA.fx + 0.5) * TILE, (meA.fy + 0.5) * TILE, map.hear_radius * TILE, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  for (const z of map.zones) drawLabel(ctx, z.name, z.x * TILE + 3, z.y * TILE + 2, "rgba(18,14,20,.75)", ROOM_COLORS.voice);
  for (const l of map.labels) drawLabel(ctx, l.name, l.x * TILE + 2, l.y * TILE + 3, "rgba(18,14,20,.75)", ROOM_COLORS.amber);
  drawBeagle(ctx, Math.round(beagle.fx * TILE), beagle.y * TILE, beagle.frame, beagle.flip);

  // People, back to front.
  const byId = new Map(st.members.map((m) => [m.userId, m]));
  const people = [...actors.values()].filter((a) => byId.has(a.id)).sort((a, b) => a.fy - b.fy);
  for (const a of people) {
    const m = byId.get(a.id)!;
    const isMe = a.id === st.me;
    const x = Math.round(a.fx * TILE);
    const y = Math.round(a.fy * TILE) - 2;
    const vol = isMe ? 1 : meM?.listening ? volumeFor(meM, m) : 0;
    const talking = sp.has(a.id) && m.mode === "room";
    if (talking && vol > 0) {
      ctx.strokeStyle = ROOM_COLORS.voice;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(x + 8, y + 15, 8, 3, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    const tile = tileOf(map.tiles, a.x, a.y);
    const sitting = (tile === "c" || tile === "s") && !a.moving;
    const step = a.moving && !rm ? (a.moving.t < 0.5 ? 1 : 2) : 0;
    const look: Look = lookFor(a.id);
    ctx.save();
    if (a.flip && a.dir === "side") {
      ctx.translate(x * 2 + 16, 0);
      ctx.scale(-1, 1);
    }
    drawPerson(ctx, x, y, look, m.mode === "text" ? "up" : a.dir, step, sitting);
    ctx.restore();
    const fg = isMe ? ROOM_COLORS.ink : vol > 0 || m.mode === "text" ? ROOM_COLORS.fg : ROOM_COLORS.dim;
    drawLabel(ctx, `${statusMark(m, talking)} ${m.name}`, x + 8, y - 9, isMe ? "rgba(242,178,76,.92)" : "rgba(18,14,20,.78)", fg, true);
  }

  // Bubbles, then reactions, on top of everything.
  for (const a of people) {
    if (a.bubble && a.bubble.until > now) drawBubble(ctx, a.bubble.text, Math.round(a.fx * TILE) + 8, Math.round(a.fy * TILE) - 12);
    else if (a.bubble) a.bubble = null;
  }
  if (beagle.bubbleUntil > now) drawBubble(ctx, "わん！", Math.round(beagle.fx * TILE) + 8, beagle.y * TILE - 2);
  for (const a of people) {
    a.reacts = a.reacts.filter((r) => now - r.t0 < 1800);
    a.reacts.forEach((r, i) => {
      const k = (now - r.t0) / 1800;
      ctx.globalAlpha = 1 - k * k;
      const rise = rm ? 0 : k * 18;
      drawEmoji(ctx, r.e, Math.round(a.fx * TILE) + 1 + i * 7, Math.round(a.fy * TILE) - (r.small ? 14 : 4) - rise, r.small ? 9 : 13);
      ctx.globalAlpha = 1;
    });
  }
}


const KEYS: Record<string, Dir> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  W: "up",
  S: "down",
  A: "left",
  D: "right",
};

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

interface MenuState {
  userId: string;
  name: string;
  text: boolean;
  left: number;
  top: number;
}

function RoomMap({ s, speaking }: { s: RoomSnapshot; speaking: Set<string> }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [hint, setHint] = useState(true);
  // Latest props for the animation loop (it runs outside React renders).
  const live = useRef({ speaking, reduced });
  useEffect(() => {
    live.current = { speaking, reduced };
  }, [speaking, reduced]);
  const view = useRef({ zoom: 3, camX: 0, camY: 0, dpr: 1 });
  const map = s.map!;
  const base = useMemo(() => (typeof document === "undefined" ? null : renderBase(map)), [map]);
  const me = myMember(s);
  const zone = me && me.mode === "room" ? zoneOf(map.zones, me.x, me.y) : null;

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 9000);
    return () => clearTimeout(t);
  }, []);

  // Canvas size and zoom: about 13 tiles across on a phone, more on a desk; whole numbers only.
  useEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    const resize = () => {
      const r = box.getBoundingClientRect();
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      const across = Math.min(map.w, Math.max(13, r.width / 46));
      view.current.zoom = Math.max(2, Math.floor(canvas.width / (TILE * across)));
      view.current.dpr = dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(box);
    return () => ro.disconnect();
  }, [map.w]);

  // The animation loop: walk, then draw.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !base) return;
    const beagle: BeagleState = { x: 0, y: 0, fx: 0, frame: 0, flip: false, bubbleUntil: performance.now() + 2500, t: 0, minX: 0, maxX: 0 };
    // The beagle pads around its bed (client-only decoration).
    const beds: { x: number; y: number }[] = [];
    map.tiles.forEach((row, y) => [...row].forEach((ch, x) => ch === "b" && beds.push({ x, y })));
    const bedY = beds[0]?.y ?? map.h - 2;
    beagle.y = bedY - 1;
    beagle.minX = Math.max(1, Math.min(...beds.map((b) => b.x), map.w) - 2);
    beagle.maxX = Math.min(map.w - 2, Math.max(...beds.map((b) => b.x), 0) + 2);
    beagle.x = beds[0]?.x ?? Math.floor(map.w / 2);
    beagle.fx = beagle.x;
    const dogFree = (x: number) => tileOf(map.tiles, x, beagle.y) !== "#" && !"wDCBTMFVP".includes(tileOf(map.tiles, x, beagle.y));

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, now - last);
      last = now;
      tickRoom(dt);
      const { speaking: sp, reduced: rm } = live.current;
      if (!rm) {
        beagle.t += dt;
        if (beagle.t > 900) {
          beagle.t = 0;
          const nx = beagle.x + (Math.random() < 0.5 ? -1 : 1);
          if (nx >= beagle.minX && nx <= beagle.maxX && dogFree(nx)) {
            beagle.flip = nx < beagle.x;
            beagle.x = nx;
          }
          beagle.frame ^= 1;
          if (Math.random() < 0.05) beagle.bubbleUntil = now + 1800;
        }
        beagle.fx += (beagle.x - beagle.fx) * 0.2;
      } else beagle.fx = beagle.x;
      drawRoom(ctx, canvas, map, base, view.current, getSnapshot(), sp, rm, now, beagle);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [base, map]);

  // Keyboard: arrows / WASD walk, 1–6 react (not while typing).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const d = KEYS[e.key];
      if (d) {
        e.preventDefault();
        setMenu(null);
        setHint(false);
        pressDir(d);
        return;
      }
      const i = "123456".indexOf(e.key);
      if (i >= 0 && e.key.length === 1) {
        const emoji = getSnapshot().reactions[i];
        if (emoji) void sendReaction(emoji);
      }
    };
    const up = (e: KeyboardEvent) => {
      const d = KEYS[e.key];
      if (d) releaseDir(d);
    };
    const blur = () => releaseDir();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
      releaseDir();
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const box = boxRef.current;
    if (!canvas || !box) return;
    const r = canvas.getBoundingClientRect();
    const v = view.current;
    const sx = (e.clientX - r.left) * v.dpr;
    const sy = (e.clientY - r.top) * v.dpr;
    const tx = Math.floor((sx / v.zoom + v.camX) / TILE);
    const ty = Math.floor((sy / v.zoom + v.camY) / TILE);
    setHint(false);
    const st = getSnapshot();
    const who = [...getActors().values()].find((a) => a.id !== st.me && Math.round(a.fx) === tx && Math.round(a.fy) === ty);
    const m = who ? st.members.find((x) => x.userId === who.id) : null;
    if (who && m) {
      const bw = box.clientWidth;
      const bh = box.clientHeight;
      setMenu({
        userId: m.userId,
        name: m.name,
        text: m.mode === "text",
        left: Math.max(4, Math.min(e.clientX - r.left, bw - 150)),
        top: Math.max(4, Math.min(e.clientY - r.top, bh - 110)),
      });
      return;
    }
    setMenu(null);
    walkTo(tx, ty);
  };

  const pad = (d: Dir, cls: string, label: string, glyph: string) => (
    <button
      type="button"
      className={cls}
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        setHint(false);
        setMenu(null);
        e.currentTarget.setPointerCapture(e.pointerId);
        pressDir(d);
      }}
      onPointerUp={() => releaseDir(d)}
      onPointerCancel={() => releaseDir(d)}
      onLostPointerCapture={() => releaseDir(d)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {glyph}
    </button>
  );

  return (
    <section ref={boxRef} className={css.mapBox} aria-label="部室のマップ">
      <canvas ref={canvasRef} className={css.canvas} onPointerDown={onPointerDown} />
      {hint && (
        <div className={`${css.overlay} ${css.hint}`}>タップした所へ歩く・人をタップで手を振る・矢印キー / WASD・1〜6 でリアクション</div>
      )}
      {zone && !hint && <div className={`${css.overlay} ${css.zone}`}>{zone.name}にいます</div>}
      <div className={css.react} role="group" aria-label="リアクション">
        {s.reactions.map((e, i) => (
          <button key={e} type="button" aria-label={`${e}（${i + 1}）`} title={`${e}（${i + 1}）`} onClick={() => void sendReaction(e)}>
            {e}
          </button>
        ))}
      </div>
      <div className={css.pad} aria-label="移動">
        {pad("up", css.padUp, "上へ", "▲")}
        {pad("left", css.padLeft, "左へ", "◀")}
        {pad("right", css.padRight, "右へ", "▶")}
        {pad("down", css.padDown, "下へ", "▼")}
      </div>
      {menu && (
        <div className={css.menu} style={{ left: menu.left, top: menu.top }} role="menu">
          <div className={css.menuName}>
            {menu.name}
            {menu.text ? "（テキストで参加）" : ""}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void sendReaction("👋", menu.userId);
              setMenu(null);
            }}
          >
            👋 手を振る
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const a = getActors().get(menu.userId);
              if (a) walkTo(a.x, a.y, true);
              setMenu(null);
            }}
          >
            そばへ行く
          </button>
        </div>
      )}
    </section>
  );
}
