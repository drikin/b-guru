"use client";
/* ✉️ 簡易 DM（Web）。状態は lib/dm-client.ts（React の外）。
 *
 *   DmTabLabel   上のタブ（タイムライン・☆・🔖・チャット）の「✉️ DM」と未読の数。押すと DM の一覧（2026-11-08 にチャットの上の ✉️ から移した）。
 *   DmToggle     （今は使っていない。チャットの上の ✉️ ボタン）
 *   DmNameMenu   チャットの発言の名前・アイコンを押すと「DM を送る」。
 *   DmPane       DM の一覧／1 つの会話（30 日以内のやりとり・入力欄）。チャットと同じく画面の中央に出す
 *                （2026-11-08 オーナー「DMもチャット欄と同様に、中央に表示してください」。以前は右から出る引き出し）。
 * DM_ENABLED の対象でない人には何も出さない（GET /api/dm が 404）。 */
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActionIcon, Avatar, Badge, Box, Button, Group, Indicator, Loader, Menu, ScrollArea, Stack, Text, Textarea, Tooltip, UnstyledButton } from "@mantine/core";
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
  onDmRestore,
  editDmMessage,
  toggleDmReaction,
  sendDmMessage,
  subscribe,
  type DmMessage,
  type DmPeer,
  type DmSnapshot,
} from "@/lib/dm-client";
import { chatTimeStr } from "@/lib/date-format";
import { handleComposerKeyDown } from "@/lib/composer-keys";
import { DmDropOverlay, DmImageGrid, DmPhotoButton, DmPhotoTray, useDmPhotoDrop, useDmPhotoPicker } from "./DmPhotos";
import { dmPreviewText } from "@/lib/dm-photos-client";
import { closeGroup, loadGdm, pruneGdmNow } from "@/lib/gdm-client";
import { CreateGroupModal, GroupRow, GroupThread, NewDmModal, useGdm } from "./GroupDM";
import { DmActions, DmBody, DmEditBox, EditedMark, useDmChatKit } from "./DmChatKit";

const DM_MAX_BODY = 1000;

export function useDm(): DmSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 「✉️」と未読の数（DM が使える人だけ）。 */
export function DmToggle() {
  const s0 = useDm();
  const g = useGdm();
  useEffect(() => {
    if (s0.status === "unknown") void loadDm();
  }, [s0.status]);
  useEffect(() => {
    if (s0.status === "enabled" && g.status === "unknown") void loadGdm();
  }, [s0.status, g.status]);
  if (s0.status !== "enabled") return null;
  // 👥 グループの未読も足して出す
  const s = { ...s0, unread: s0.unread + (g.status === "enabled" ? g.unread : 0) };
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
          onClick={() => (s.open ? (closeGroup(), closeDm()) : openDmList())}
        >
          <span aria-hidden style={{ fontSize: 15, lineHeight: 1 }}>
            ✉️
          </span>
        </ActionIcon>
      </Indicator>
    </Tooltip>
  );
}

/** 上のタブ（タイムライン・☆・🔖・チャット）に並べる ✉️ DM（rbtnn さん 2026-11-08「チャット→DM→グループのタップ数が長い」）。
 *  1 タップで DM の一覧を開く。未読は 1 対 1 とグループの合計。 */
export function DmTabLabel() {
  const s0 = useDm();
  const g = useGdm();
  useEffect(() => {
    if (s0.status === "unknown") void loadDm();
  }, [s0.status]);
  useEffect(() => {
    if (s0.status === "enabled" && g.status === "unknown") void loadGdm();
  }, [s0.status, g.status]);
  const unread = s0.unread + (g.status === "enabled" ? g.unread : 0);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }} title="DM（30 日で消えます）" data-cx="dm-tab">
      ✉️ DM
      {unread > 0 && (
        <span
          style={{
            minWidth: 18,
            height: 18,
            borderRadius: 9,
            padding: "0 5px",
            background: "#e03131",
            color: "#fff",
            fontSize: "0.6875rem",
            fontWeight: 700,
            lineHeight: "18px",
            textAlign: "center",
            display: "inline-block",
          }}
        >
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </span>
  );
}

/** DM が使えるか（上のタブに ✉️ DM を出すかどうか。状態が変わったときだけ描き直す）。 */
export function useDmEnabled(): boolean {
  const unknown = useSyncExternalStore(subscribe, () => getSnapshot().status === "unknown", () => true);
  useEffect(() => {
    if (unknown) void loadDm();
  }, [unknown]);
  return useSyncExternalStore(subscribe, () => getSnapshot().status === "enabled", () => false);
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
        <Menu.Item leftSection={<span aria-hidden>✉️</span>} onClick={() => (closeGroup(), void openDm(peer))}>
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

/** 中央に出す DM（一覧 / 会話）。page.tsx がチャットと同じ枠（.bguru-chat-view）の中に置く。開いていなければ何も出さない。 */
export function DmPane() {
  const s = useDm();
  const g = useGdm();
  useEffect(() => {
    if (!s.open) return;
    const t = setInterval(() => (pruneNow(), pruneGdmNow()), 60_000);
    return () => clearInterval(t);
  }, [s.open]);
  if (s.status !== "enabled" || !s.open) return null;
  return (
    <Box
      data-cx="dm-pane"
      style={{
        flex: 1,
        minHeight: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        background: "var(--bg-surface, var(--mantine-color-body))",
        border: "1px solid var(--border-green, var(--mantine-color-default-border))",
        borderRadius: 12,
      }}
    >
      {g.current ? <GroupThread key={`g${g.current.id}`} s={g} /> : s.peer ? <DmThread key={s.peer.user_id} s={s} peer={s.peer} /> : <DmList s={s} />}
    </Box>
  );
}

function Header({ title, onBack, left, right }: { title: ReactNode; onBack: () => void; left?: ReactNode; right?: ReactNode }) {
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
      {right}
      <ActionIcon variant="subtle" color="gray" onClick={closeDm} aria-label="閉じる">
        ✕
      </ActionIcon>
    </Group>
  );
}

function DmList({ s }: { s: DmSnapshot }) {
  const g = useGdm();
  const [creating, setCreating] = useState(false);
  const [newDm, setNewDm] = useState(false);
  const groupsOn = g.status === "enabled";
  // 1 対 1 とグループを新しい順に混ぜる
  const items = [
    ...s.conversations.map((c) => ({ key: `p${c.peer.user_id}`, at: c.last_message.created_at, c, gs: null })),
    ...(groupsOn ? g.groups : []).map((gs) => ({ key: `g${gs.group.id}`, at: gs.last_message?.created_at ?? gs.group.created_at, c: null, gs })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  return (
    <>
      <Header
        title="DM"
        onBack={closeDm}
        right={
          <Group gap={6} wrap="nowrap">
            <Button size="compact-xs" variant="light" color="green" onClick={() => setNewDm(true)} data-cx="dm-new">
              ＋ 新規 DM
            </Button>
            {groupsOn && (
              <Button size="compact-xs" variant="light" color="green" onClick={() => setCreating(true)} data-cx="gdm-create">
                ＋ グループ
              </Button>
            )}
          </Group>
        }
      />
      <NewDmModal opened={newDm} onClose={() => setNewDm(false)} />
      {groupsOn && <CreateGroupModal opened={creating} onClose={() => setCreating(false)} />}
      <ScrollArea style={{ flex: 1 }}>
        {items.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="xl" px="md">
            DM はまだありません。「＋ 新規 DM」で名前を入れて始めるか、チャットで名前を押すと「DM を送る」が出ます。
            {groupsOn ? "「＋ グループ」で何人かと話せます。" : ""}
          </Text>
        ) : (
          <Stack gap={0}>
            {items.map(({ key, c, gs }) =>
              gs ? (
                <GroupRow key={key} g={gs} />
              ) : c ? (
              <UnstyledButton
                key={c.peer.user_id}
                onClick={() => (closeGroup(), void openDm(c.peer))}
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
                        {dmPreviewText(c.last_message)}
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
              ) : null
            )}
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
  const picker = useDmPhotoPicker();
  // 送れなかった写真（大きすぎ・ログイン切れなど）は本文と一緒に入力欄へ戻る。
  const put = picker.put;
  useEffect(
    () =>
      onDmRestore((r) => {
        setDraft((cur) => cur || r.body);
        put(r.photos);
      }),
    [put]
  );
  const drop = useDmPhotoDrop(picker, s.canSend);
  const kit = useDmChatKit();
  const [editingId, setEditingId] = useState<number | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, peer.user_id]);
  const canSend = (!!draft.trim() || picker.photos.length > 0) && draft.length <= DM_MAX_BODY && picker.busy === 0;
  const send = () => {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void sendDmMessage(text, picker.take());
  };
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} {...drop.handlers}>
      <DmDropOverlay show={drop.over} />
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
            s.messages.map((m) => (
              <DmBubble
                key={m.client_id ?? m.id}
                m={m}
                editing={editingId === m.id}
                onToggleReaction={kit && m.id > 0 ? (emoji) => void toggleDmReaction(m.id, emoji, kit.myName) : undefined}
                onEdit={m.is_author && m.id > 0 && !m.pending && !m.failed ? () => setEditingId(m.id) : undefined}
                onSaveEdit={async (text) => {
                  const err = await editDmMessage(m.id, text);
                  if (!err) setEditingId(null);
                  return err;
                }}
                onCancelEdit={() => setEditingId(null)}
              />
            ))
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
          <>
          <DmPhotoTray picker={picker} />
          <Group gap={6} align="flex-end" wrap="nowrap">
            <DmPhotoButton picker={picker} />
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
              onPaste={picker.onPaste}
              data-cx="dm-input"
            />
            <Button color="green" onClick={send} disabled={!canSend}>
              送信
            </Button>
          </Group>
          </>
        ) : (
          <Text size="xs" c="dimmed" ta="center">
            この人にはまだ DM を送れません
          </Text>
        )}
      </Box>
    </div>
  );
}

function DmBubble({
  m,
  editing,
  onToggleReaction,
  onEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  m: DmMessage;
  editing: boolean;
  onToggleReaction?: (emoji: string) => void;
  onEdit?: () => void;
  onSaveEdit: (text: string) => Promise<string | null>;
  onCancelEdit: () => void;
}) {
  const mine = m.is_author;
  const actions = <DmActions reactions={m.reactions ?? []} onToggleReaction={onToggleReaction} onEdit={onEdit} />;
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", opacity: m.pending ? 0.6 : 1 }}>
      <div style={{ maxWidth: "82%", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
        {editing ? (
          <>
            {(m.images?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 6 }}>
                <DmImageGrid urls={m.images} />
              </div>
            )}
            <DmEditBox initial={m.body} allowEmpty={(m.images?.length ?? 0) > 0} maxLength={DM_MAX_BODY} onSave={onSaveEdit} onCancel={onCancelEdit} />
          </>
        ) : (
        <Group gap={4} align="center" wrap="nowrap" justify={mine ? "flex-end" : "flex-start"} style={{ maxWidth: "100%" }}>
        {mine && actions}
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
          {(m.images?.length ?? 0) > 0 && (
            <div style={{ margin: m.body ? "2px -4px 6px" : "2px -4px" }}>
              <DmImageGrid urls={m.images} />
            </div>
          )}
          <DmBody body={m.body} />
        </div>
        {!mine && actions}
        </Group>
        )}
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
            <>
              {m.edited && <EditedMark />}
              <Text size="xs" c="dimmed" style={{ opacity: 0.7 }}>
                {chatTimeStr(m.created_at)}
              </Text>
            </>
          )}
        </Group>
      </div>
    </div>
  );
}
