"use client";
/* Voice room strip for the web chat, matching the native apps (VoiceBar.swift):
 *   room empty, not in it     → 🎙 ボイスルーム 誰もいません [開く]
 *   people talking, not in it → 🎙 N 人が話しています (faces) [参加]
 *   in the room               → faces (ring = talking, slash = muted) [mic] [⚙] [退出]
 * VoiceMini: a small floating pill while in the room but away from the chat,
 * so a live mic is never out of reach. Hidden unless voice is on for this member. */
import { useEffect, useSyncExternalStore } from "react";
import { ActionIcon, Avatar, Button, Group, Loader, Menu, Popover, ScrollArea, Text, Tooltip, UnstyledButton } from "@mantine/core";
import {
  canModerate,
  getServerSnapshot,
  getSnapshot,
  joinVoice,
  kickVoice,
  leaveVoice,
  loadVoice,
  micActive,
  selectInput,
  selectOutput,
  setMic,
  subscribe,
  unlockAudio,
  voiceLoaded,
  type VoiceSnapshot,
} from "@/lib/voice-client";

function useVoice(): VoiceSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const GREEN = "var(--text-green, #2b8a3e)";

function Face({ name, avatar, size, speaking, muted }: { name: string; avatar: string | null; size: number; speaking?: boolean; muted?: boolean }) {
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }} title={name}>
      <Avatar
        src={avatar ?? undefined}
        size={size}
        radius="xl"
        color="green"
        style={{ boxShadow: speaking ? `0 0 0 2px ${GREEN}` : "none", transition: "box-shadow 120ms" }}
        imageProps={{ onError: (e) => ((e.currentTarget as HTMLImageElement).style.display = "none") }}
      >
        {name.charAt(0).toUpperCase()}
      </Avatar>
      {muted && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            width: 14,
            height: 14,
            borderRadius: 7,
            background: "var(--mantine-color-gray-6)",
            color: "#fff",
            display: "grid",
            placeItems: "center",
          }}
        >
          <MicIcon off size={9} />
        </span>
      )}
    </div>
  );
}

function MicIcon({ off, size = 16, bold }: { off?: boolean; size?: number; bold?: boolean }) {
  const w = bold ? 2.6 : 1.8;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill={bold ? "currentColor" : "none"} />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      {off && <path d="M4 4l16 16" />}
    </svg>
  );
}

/** Mute toggle that shows whether my voice is going out. */
function MicButton({ s }: { s: VoiceSnapshot }) {
  const active = micActive(s);
  const label = s.micOn ? "ミュートする" : "ミュートを解除して話す";
  return (
    <Tooltip label={label} openDelay={400}>
      <UnstyledButton
        onClick={() => void setMic(!s.micOn)}
        disabled={s.phase !== "connected"}
        aria-label={label}
        aria-pressed={s.micOn}
        style={{
          position: "relative",
          width: 38,
          height: 30,
          borderRadius: 8,
          display: "grid",
          placeItems: "center",
          color: active ? "#fff" : s.micOn ? GREEN : "var(--mantine-color-dimmed)",
          background: active ? GREEN : "var(--bg-subtle)",
          border: `1.5px solid ${s.micOn ? GREEN : "transparent"}`,
          outline: active ? `3px solid color-mix(in srgb, ${GREEN} 40%, transparent)` : "none",
          outlineOffset: active ? 1 + Math.round(s.micLevel * 3) : 0,
          transition: "outline-offset 120ms ease-out, background 120ms",
          opacity: s.phase !== "connected" ? 0.6 : 1,
        }}
      >
        <MicIcon off={!s.micOn} bold={active} />
        {s.micBusy && <Loader size={10} style={{ position: "absolute", right: 2, bottom: 2 }} />}
      </UnstyledButton>
    </Tooltip>
  );
}

function DeviceMenu({ s }: { s: VoiceSnapshot }) {
  if (s.inputs.length <= 1 && s.outputs.length <= 1) return null;
  return (
    <Menu position="bottom-end" withinPortal shadow="md">
      <Menu.Target>
        <ActionIcon variant="subtle" color="gray" aria-label="マイクとスピーカーを選ぶ">
          <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden>
            <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
            <circle cx="16" cy="6" r="2" />
            <circle cx="10" cy="12" r="2" />
            <circle cx="18" cy="18" r="2" />
          </svg>
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        {s.inputs.length > 1 && <Menu.Label>マイク</Menu.Label>}
        {s.inputs.length > 1 &&
          s.inputs.map((d) => (
            <Menu.Item key={`in-${d.id}`} onClick={() => void selectInput(d.id)} leftSection={s.inputId === d.id ? "✓" : " "}>
              {d.name}
            </Menu.Item>
          ))}
        {s.outputs.length > 1 && <Menu.Label>スピーカー</Menu.Label>}
        {s.outputs.map((d) => (
          <Menu.Item key={`out-${d.id}`} onClick={() => void selectOutput(d.id)} leftSection={s.outputId === d.id ? "✓" : " "}>
            {d.name}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

export default function VoiceBar() {
  const s = useVoice();
  useEffect(() => {
    if (!voiceLoaded()) void loadVoice();
  }, []);
  if (!s.enabled) return null;

  const inRoom = s.phase !== "idle";
  const people = s.roomInfo?.active ? s.roomInfo.participants : [];
  const mod = canModerate(s);

  return (
    <div
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid var(--border-green-soft, var(--mantine-color-default-border))",
        background: `color-mix(in srgb, ${GREEN} ${inRoom ? 10 : 4}%, transparent)`,
        display: "flex",
        flexDirection: "column",
        gap: 4,
      }}
    >
      {inRoom ? (
        <Group gap={8} wrap="nowrap">
          {(s.phase === "connecting" || s.phase === "reconnecting") && (
            <Group gap={4} wrap="nowrap">
              <Loader size={12} />
              <Text size="xs" c="dimmed">
                {s.phase === "connecting" ? "接続中…" : "再接続中…"}
              </Text>
            </Group>
          )}
          <div style={{ display: "flex", gap: 8, padding: 3, flex: 1, minWidth: 0, alignItems: "center" }}>
            {s.members.slice(0, FACE_SLOTS).map((m) => (
              <MemberFace key={m.userId} s={s} m={m} mod={mod} />
            ))}
            {s.members.length > 1 && <AllMembers s={s} mod={mod} />}
          </div>
          {s.needsAudioUnlock && (
            <Button size="compact-xs" variant="light" color="green" onClick={() => void unlockAudio()}>
              音声を再生
            </Button>
          )}
          <MicButton s={s} />
          <DeviceMenu s={s} />
          <Button size="compact-sm" variant="light" color="red" onClick={() => void leaveVoice()}>
            退出
          </Button>
        </Group>
      ) : (
        <Group gap={8} wrap="nowrap">
          <span style={{ color: GREEN, display: "grid" }}>
            <MicIcon />
          </span>
          {people.length === 0 ? (
            <>
              <Text size="sm">ボイスルーム</Text>
              <Text size="xs" c="dimmed">
                誰もいません
              </Text>
            </>
          ) : (
            <>
              <Text size="sm" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {people.length} 人が参加中
              </Text>
              <div style={{ display: "flex", minWidth: 0, overflow: "hidden" }}>
                {people.slice(0, 6).map((p, i) => (
                  <div key={p.user_id} style={{ marginLeft: i ? -6 : 0 }}>
                    <Face name={p.name ?? "?"} avatar={p.avatar} size={22} />
                  </div>
                ))}
              </div>
            </>
          )}
          <div style={{ flex: 1 }} />
          <Button size="compact-sm" color="green" onClick={() => void joinVoice()}>
            {people.length === 0 ? "開く" : "参加"}
          </Button>
        </Group>
      )}
      {s.notice && (
        <Text size="xs" c="dimmed">
          {s.notice}
        </Text>
      )}
    </div>
  );
}

const FACE_SLOTS = 6;

function MemberFace({ s, m, mod }: { s: VoiceSnapshot; m: VoiceSnapshot["members"][number]; mod: boolean }) {
  const face = <Face name={m.name} avatar={m.avatar} size={28} speaking={m.speaking} muted={m.muted} />;
  if (!mod || m.isMe) return face;
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <UnstyledButton aria-label={`${m.name}（操作）`}>{face}</UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{m.name}</Menu.Label>
        <Menu.Item onClick={() => void kickVoice(m.userId)}>退出させる</Menu.Item>
        {s.admin && (
          <Menu.Item color="red" onClick={() => void kickVoice(m.userId, true)}>
            退出させて入室禁止
          </Menu.Item>
        )}
      </Menu.Dropdown>
    </Menu>
  );
}

/** "+N" (or 一覧) → everyone in the room, up to 100: talking, mics on, listeners. */
function AllMembers({ s, mod }: { s: VoiceSnapshot; mod: boolean }) {
  const rest = s.members.length - Math.min(s.members.length, FACE_SLOTS);
  const speakers = s.members.filter((m) => !m.muted).length;
  return (
    <Popover position="bottom-start" withinPortal shadow="md" width={300}>
      <Popover.Target>
        <UnstyledButton
          aria-label={`参加者 ${s.members.length} 人の一覧`}
          style={{
            minWidth: 30,
            height: 28,
            padding: "0 8px",
            borderRadius: 14,
            background: "var(--bg-subtle)",
            fontSize: 12,
            fontWeight: 600,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {rest > 0 ? `+${rest}` : "一覧"}
        </UnstyledButton>
      </Popover.Target>
      <Popover.Dropdown p={0}>
        <Group justify="space-between" px="sm" py={8} style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
          <Text size="sm" fw={600}>
            参加者 {s.members.length} 人
          </Text>
          <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
            話せる人 {speakers}/{s.maxSpeakers}
          </Text>
        </Group>
        <ScrollArea.Autosize mah={360}>
          {s.members.map((m) => (
            <Group key={m.userId} gap={8} px="sm" py={6} wrap="nowrap">
              <Face name={m.name} avatar={m.avatar} size={24} speaking={m.speaking} />
              <Text size="sm" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.name}
                {m.isMe ? "（自分）" : ""}
              </Text>
              {m.speaking && (
                <Text size="xs" c="green">
                  話しています
                </Text>
              )}
              <span style={{ color: m.muted ? "var(--mantine-color-dimmed)" : GREEN, display: "grid" }} aria-label={m.muted ? "ミュート中" : "マイク オン"}>
                <MicIcon off={m.muted} size={14} />
              </span>
              {mod && !m.isMe && (
                <Menu position="left-start" withinPortal>
                  <Menu.Target>
                    <ActionIcon size="sm" variant="subtle" color="gray" aria-label={`${m.name} の操作`}>
                      ⋯
                    </ActionIcon>
                  </Menu.Target>
                  <Menu.Dropdown>
                    <Menu.Item onClick={() => void kickVoice(m.userId)}>退出させる</Menu.Item>
                    {s.admin && (
                      <Menu.Item color="red" onClick={() => void kickVoice(m.userId, true)}>
                        退出させて入室禁止
                      </Menu.Item>
                    )}
                  </Menu.Dropdown>
                </Menu>
              )}
            </Group>
          ))}
        </ScrollArea.Autosize>
      </Popover.Dropdown>
    </Popover>
  );
}

/** Floating pill while in the room but the chat is not on screen. */
export function VoiceMini({ hidden, onOpenChat }: { hidden: boolean; onOpenChat: () => void }) {
  const s = useVoice();
  if (hidden || s.phase === "idle") return null;
  return (
    <div
      role="region"
      aria-label="ボイスルーム（通話中）"
      style={{
        position: "fixed",
        left: "max(16px, env(safe-area-inset-left, 0px))",
        bottom: "calc(16px + env(safe-area-inset-bottom, 0px))",
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px 6px 12px",
        borderRadius: 999,
        background: "var(--bg-surface, var(--mantine-color-body))",
        border: `1px solid ${GREEN}`,
        boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
      }}
    >
      <UnstyledButton onClick={onOpenChat} aria-label="チャットのボイスルームを開く">
        <Text size="sm" style={{ whiteSpace: "nowrap" }}>
          🎙 通話中 · {s.members.length} 人
        </Text>
      </UnstyledButton>
      <MicButton s={s} />
      <Button size="compact-xs" variant="light" color="red" onClick={() => void leaveVoice()}>
        退出
      </Button>
    </div>
  );
}
