"use client";
/* ✉️ 簡易 DM（Web）。状態は lib/dm-client.ts（React の外）。
 *
 *   DmToggle     チャットの上の行（☗・🎮 の隣）に「✉️」と未読の数。押すと DM の一覧。
 *   DmNameMenu   チャットの発言の名前・アイコンを押すと「DM を送る」。
 *   DmDrawer     右から出る DM の一覧／1 つの会話（30 日以内のやりとり・入力欄）。
 * DM_ENABLED の対象でない人には何も出さない（GET /api/dm が 404）。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActionIcon, Avatar, Badge, Box, Button, Drawer, Group, Indicator, Loader, Menu, ScrollArea, Stack, Text, Textarea, Tooltip, UnstyledButton } from "@mantine/core";
import {
  closeDm,
  discardDm,
  getServerSnapshot,
  getSnapshot,
  loadDm,
  openDm,
  openDmList,
  pruneNow,
  retryDm,
  sendDmMessage,
  subscribe,
  type DmMessage,
  type DmPeer,
  type DmSnapshot,
} from "@/lib/dm-client";
import { chatTimeStr } from "@/lib/date-format";
import { handleComposerKeyDown } from "@/lib/composer-keys";

const DM_MAX_BODY = 1000;

export function useDm(): DmSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 「✉️」と未読の数（DM が使える人だけ）。 */
export function DmToggle() {
  const s = useDm();
  useEffect(() => {
    if (s.status === "unknown") void loadDm();
  }, [s.status]);
  if (s.status !== "enabled") return null;
  return (
    <Tooltip label="DM（30 日で消えます）" openDelay={400}>
      <Indicator label={s.unread > 99 ? "99+" : s.unread} size={16} color="red" disabled={s.unread === 0} offset={4}>
        <ActionIcon
          size="md"
          variant={s.open ? "filled" : "light"}
          color="green"
          aria-label={s.unread > 0 ? `DM（未読 ${s.unread} 件）` : "DM"}
          title="DM"
          data-cx="dm-toggle"
          onClick={() => (s.open ? closeDm() : openDmList())}
        >
          <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
            ✉️
          </span>
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}

/** チャットの発言の名前・アイコン → 「DM を送る」。使えない人・自分・B-guru にはそのまま出す。 */
export function DmNameMenu({ peer, children }: { peer: DmPeer | null; children: ReactNode }) {
  const s = useDm();
  if (s.status !== "enabled" || !peer?.user_id) return <>{children}</>;
  return (
    <Menu position="bottom-start" withinPortal shadow="md">
      <Menu.Target>
        <UnstyledButton aria-label={`${peer.name ?? ""} さんのメニュー`} data-cx="dm-name" style={{ borderRadius: 6 }}>
          {children}
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{peer.name ?? "会員"}</Menu.Label>
        <Menu.Item leftSection={<span aria-hidden>✉️</span>} onClick={() => void openDm(peer)}>
          DM を送る
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
  );
}

function PeerAvatar({ peer, size = "sm" }: { peer: DmPeer; size?: "xs" | "sm" | "md" }) {
  const [failed, setFailed] = useState(false);
  return (
    <Avatar src={!failed && peer.avatar ? peer.avatar : undefined} size={size} radius="xl" color="green" onError={() => setFailed(true)}>
      {(peer.name ?? "?").charAt(0).toUpperCase()}
    </Avatar>
  );
}

/** 右から出る DM（一覧 / 会話）。 */
export function DmDrawer() {
  const s = useDm();
  useEffect(() => {
    if (!s.open) return;
    const t = setInterval(pruneNow, 60_000);
    return () => clearInterval(t);
  }, [s.open]);
  if (s.status !== "enabled") return null;
  return (
    <Drawer
      opened={s.open}
      onClose={closeDm}
      position="right"
      size="min(440px, 100vw)"
      padding={0}
      withCloseButton={false}
      data-cx="dm-drawer"
      styles={{ body: { height: "100%", display: "flex", flexDirection: "column", padding: 0 } }}
    >
      {s.peer ? <DmThread key={s.peer.user_id} s={s} peer={s.peer} /> : <DmList s={s} />}
    </Drawer>
  );
}

function Header({ title, onBack, left }: { title: ReactNode; onBack: () => void; left?: ReactNode }) {
  return (
    <Group gap={8} px="sm" py={8} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      <ActionIcon variant="subtle" color="gray" onClick={onBack} aria-label="戻る">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </ActionIcon>
      {left}
      <Text fw={600} size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
        {title}
      </Text>
      <ActionIcon variant="subtle" color="gray" onClick={closeDm} aria-label="閉じる">
        ✕
      </ActionIcon>
    </Group>
  );
}

function DmList({ s }: { s: DmSnapshot }) {
  return (
    <>
      <Header title="DM" onBack={closeDm} />
      <ScrollArea style={{ flex: 1 }}>
        {s.conversations.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl" px="md">
            DM はまだありません。チャットで名前を押すと「DM を送る」が出ます。
          </Text>
        ) : (
          <Stack gap={0}>
            {s.conversations.map((c) => (
              <UnstyledButton
                key={c.peer.user_id}
                onClick={() => void openDm(c.peer)}
                px="sm"
                py={10}
                style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
                data-cx="dm-conversation"
              >
                <Group gap={10} wrap="nowrap">
                  <PeerAvatar peer={c.peer} size="md" />
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text size="sm" fw={c.unread_count > 0 ? 700 : 500} truncate>
                        {c.peer.name ?? "会員"}
                      </Text>
                      <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                        {chatTimeStr(c.last_message.created_at)}
                      </Text>
                    </Group>
                    <Group gap={6} wrap="nowrap" justify="space-between">
                      <Text size="xs" c="dimmed" truncate>
                        {c.last_message.is_author ? "あなた: " : ""}
                        {c.last_message.body}
                      </Text>
                      {c.unread_count > 0 && (
                        <Badge size="sm" color="red" circle={c.unread_count < 10}>
                          {c.unread_count}
                        </Badge>
                      )}
                    </Group>
                  </Box>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        )}
      </ScrollArea>
      <Text size="xs" c="dimmed" ta="center" py={6}>
        DM は 30 日で消えます
      </Text>
    </>
  );
}

function DmThread({ s, peer }: { s: DmSnapshot; peer: DmPeer }) {
  const [draft, setDraft] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, peer.user_id]);
  const send = () => {
    const text = draft;
    if (!text.trim() || text.length > DM_MAX_BODY) return;
    setDraft("");
    void sendDmMessage(text);
  };
  return (
    <>
      <Header title={peer.name ?? "会員"} onBack={openDmList} left={<PeerAvatar peer={peer} size="sm" />} />
      <ScrollArea style={{ flex: 1 }} viewportRef={viewport}>
        <Stack gap={6} p="sm">
          {s.loadingThread && s.messages.length === 0 ? (
            <Group justify="center" py="lg">
              <Loader size="sm" />
            </Group>
          ) : s.messages.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              {peer.name ?? "会員"} さんとの DM（30 日で消えます）
            </Text>
          ) : (
            s.messages.map((m) => <DmBubble key={m.client_id ?? m.id} m={m} />)
          )}
        </Stack>
      </ScrollArea>
      {s.error && (
        <Text size="xs" c="red" px="sm" pb={4}>
          {s.error}
        </Text>
      )}
      <Box p="sm" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
        {s.canSend ? (
          <Group gap={6} align="flex-end" wrap="nowrap">
            <Textarea
              style={{ flex: 1 }}
              autosize
              minRows={1}
              maxRows={6}
              value={draft}
              placeholder={`${peer.name ?? "会員"} さんへ（30 日で消えます）`}
              aria-label="DM の本文"
              error={draft.length > DM_MAX_BODY ? `${DM_MAX_BODY} 文字までです` : undefined}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => void handleComposerKeyDown(e, { onSend: send })}
              data-cx="dm-input"
            />
            <Button color="green" onClick={send} disabled={!draft.trim() || draft.length > DM_MAX_BODY}>
              送信
            </Button>
          </Group>
        ) : (
          <Text size="xs" c="dimmed" ta="center">
            この人にはまだ DM を送れません
          </Text>
        )}
      </Box>
    </>
  );
}

function DmBubble({ m }: { m: DmMessage }) {
  const mine = m.is_author;
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", opacity: m.pending ? 0.6 : 1 }}>
      <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
        <div
          style={{
            background: mine ? "var(--bg-surface, var(--mantine-color-body))" : "var(--bg-subtle, var(--mantine-color-gray-1))",
            border: mine ? "1px solid var(--border-green, var(--mantine-color-green-4))" : "1px solid transparent",
            borderRadius: mine ? "14px 14px 2px 14px" : "14px 14px 14px 2px",
            padding: "6px 10px",
            fontSize: "0.8125rem",
            lineHeight: 1.45,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {m.body}
        </div>
        <Group gap={6}>
          {m.failed ? (
            <>
              <Text size="xs" c="red">
                送信できませんでした
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={() => retryDm(m)}>
                再送
              </Button>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => discardDm(m)}>
                取り消す
              </Button>
            </>
          ) : (
            <Text size="xs" c="dimmed" style={{ opacity: 0.7 }}>
              {chatTimeStr(m.created_at)}
            </Text>
          )}
        </Group>
      </div>
    </div>
  );
}
