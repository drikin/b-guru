"use client";
/* 👥 グループ DM（Web）。状態は lib/gdm-client.ts。DM の引き出し（DMPanel.tsx）の中に出す。docs/group-dm-spec.md。
 *
 *   GroupRow          DM の一覧の 1 行（👥・表示名・最後の発言・未読）
 *   GroupThread       1 つのグループ（吹き出しに送り主、system 行は中央に小さく）
 *   GroupMembers      メンバー・追加・外す（作った人だけ）・抜ける・名前・🔕 通知を切る
 *   CreateGroupModal  ＋ グループ（メンバーを選ぶ・名前は任意） */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActionIcon, Avatar, Badge, Box, Button, Group as MGroup, Loader, Modal, MultiSelect, ScrollArea, Select, Stack, Switch, Text, Textarea, TextInput, UnstyledButton } from "@mantine/core";
import {
  addGroupMembers,
  closeGroup,
  createGroup,
  discardGroupText,
  getGdmServerSnapshot,
  getGdmSnapshot,
  removeGroupMember,
  removeGroupPhoto,
  setGroupPhoto,
  renameGroup,
  retryGroupText,
  sendGroupText,
  onGroupRestore,
  setGroupMuted,
  setGroupBeagle,
  subscribeGdm,
  openGroup,
  editGroupText,
  toggleGroupReaction,
  type GdmSnapshot,
  type GMessage,
  type Group,
  type GroupSummary,
  pickerCandidates,
} from "@/lib/gdm-client";
import { closeDm, getSnapshot as getDmSnapshot, openDm, openDmList } from "@/lib/dm-client";
import { chatTimeStr } from "@/lib/date-format";
import { handleComposerKeyDown } from "@/lib/composer-keys";
import { DmDropOverlay, DmImageGrid, DmPhotoButton, DmPhotoTray, useDmPhotoDrop, useDmPhotoPicker } from "./DmPhotos";
import { dmPreviewText } from "@/lib/dm-photos-client";
import { mentionToken } from "@/lib/chat-mention";
import { DmActions, DmBody, DmEditBox, EditedMark, useDmChatKit } from "./DmChatKit";

const MAX_BODY = 1000;
const MAX_NAME = 40;

export function useGdm(): GdmSnapshot {
  return useSyncExternalStore(subscribeGdm, getGdmSnapshot, getGdmServerSnapshot);
}

/** 会員の一覧（@ 補完と同じ /api/members）。 */
type Member = { userId: string; name: string; avatar: string | null };
let membersCache: Promise<Member[]> | null = null;
/** 自分の user_id（/api/members の me。新規 DM の候補から外す）。 */
let myUserId: string | null = null;
function loadMembers(): Promise<Member[]> {
  membersCache ??= fetch("/api/members", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { members: [] }))
    .then((j) => {
      if (typeof j?.me === "string") myUserId = j.me;
      return ((j?.members as Member[]) ?? []).filter((m) => m?.userId);
    })
    .catch(() => {
      membersCache = null;
      return [];
    });
  return membersCache;
}

function useMembers(open: boolean): Member[] {
  const [list, setList] = useState<Member[]>([]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadMembers().then((m) => alive && setList(m));
    return () => {
      alive = false;
    };
  }, [open]);
  return list;
}

function MemberPicker({ open, exclude, value, onChange }: { open: boolean; exclude: Set<string>; value: string[]; onChange: (v: string[]) => void }) {
  const members = useMembers(open);
  const [search, setSearch] = useState("");
  const [labels, setLabels] = useState<Record<string, string>>({});
  const selected = value.map((v) => ({ value: v, label: labels[v] ?? "会員" }));
  const data = pickerCandidates(members, getDmSnapshot().conversations.map((c) => c.peer), exclude, search, selected);
  return (
    <MultiSelect
      label="メンバー"
      placeholder={value.length ? "" : "名前を入れて探す"}
      data={data}
      value={value}
      onChange={(v) => {
        const next = { ...labels };
        for (const d of data) next[d.value] = d.label;
        setLabels(next);
        onChange(v);
        setSearch("");
      }}
      searchable
      searchValue={search}
      onSearchChange={setSearch}
      filter={({ options }) => options.filter((o) => !("value" in o) || !value.includes(o.value))}
      clearable
      nothingFoundMessage={search.trim() ? (members.length ? "見つかりません" : "読み込み中…") : "名前を入れて探してください"}
      comboboxProps={{ withinPortal: true }}
      data-cx="gdm-member-picker"
    />
  );
}

function GroupIcon({ size = 38, photo }: { size?: number; photo?: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <Avatar size={size} radius="xl" color="green" aria-hidden src={photo && !failed ? photo : undefined} onError={() => setFailed(true)}>
      <span style={{ fontSize: size * 0.5 }}>👥</span>
    </Avatar>
  );
}

function SmallAvatar({ src, name }: { src: string | null; name: string | null }) {
  const [failed, setFailed] = useState(false);
  return (
    <Avatar src={!failed && src ? src : undefined} size="sm" radius="xl" color="green" onError={() => setFailed(true)}>
      {(name ?? "?").charAt(0).toUpperCase()}
    </Avatar>
  );
}

/** DM の一覧の 1 行。 */
export function GroupRow({ g }: { g: GroupSummary }) {
  const last = g.last_message;
  return (
    <UnstyledButton
      onClick={() => void openGroup(g.group.id)}
      px="sm"
      py={10}
      style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
      data-cx="gdm-row"
    >
      <MGroup gap={10} wrap="nowrap">
        <GroupIcon photo={g.group.photo} />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <MGroup gap={6} wrap="nowrap" justify="space-between">
            <Text size="sm" fw={g.unread_count > 0 ? 700 : 500} truncate>
              {g.group.title}
              <Text span size="xs" c="dimmed" fw={400}>
                {" "}
                ({g.group.member_count}){g.group.muted ? " 🔕" : ""}
              </Text>
            </Text>
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              {chatTimeStr(last?.created_at ?? g.group.created_at)}
            </Text>
          </MGroup>
          <MGroup gap={6} wrap="nowrap" justify="space-between">
            <Text size="xs" c="dimmed" truncate>
              {!last ? "まだ発言はありません" : last.kind === "system" ? last.body : `${last.is_author ? "あなた" : (last.from_name ?? "会員")}: ${dmPreviewText(last)}`}
            </Text>
            {g.unread_count > 0 && (
              <Badge size="sm" color="red" circle={g.unread_count < 10}>
                {g.unread_count}
              </Badge>
            )}
          </MGroup>
        </Box>
      </MGroup>
    </UnstyledButton>
  );
}

/** ＋ 新規 DM（2026-11-08 オーナー「新規 DM を作るメニュー、ユーザー名補完で」）。名前を入れると候補が出る
 *  （何も入れないうちは今までの DM の相手だけ。会員の一覧を最初から全部は見せない）。選ぶとその人との DM を開く。 */
export function NewDmModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const members = useMembers(opened);
  const [search, setSearch] = useState("");
  const peers = getDmSnapshot().conversations.map((c) => c.peer);
  const exclude = new Set(myUserId ? [myUserId] : []);
  const data = pickerCandidates(members, peers, exclude, search);
  const close = () => {
    setSearch("");
    onClose();
  };
  const pick = (id: string | null) => {
    if (!id) return;
    const peer = peers.find((p) => p.user_id === id);
    const m = members.find((x) => x.userId === id);
    close();
    openDm(peer ?? { user_id: id, name: m?.name ?? null, avatar: m?.avatar ?? null });
  };
  return (
    <Modal opened={opened} onClose={close} title="✉️ 新しい DM" centered zIndex={1000}>
      <Stack gap="sm">
        <Select
          label="相手"
          placeholder="名前を入れて探す"
          data={data}
          value={null}
          onChange={pick}
          searchable
          searchValue={search}
          onSearchChange={setSearch}
          nothingFoundMessage={search.trim() ? (members.length ? "見つかりません" : "読み込み中…") : "名前を入れて探してください"}
          comboboxProps={{ withinPortal: true, zIndex: 1100 }}
          data-autofocus
          data-cx="dm-new-picker"
        />
        <Text size="xs" c="dimmed">
          DM は 30 日で消えます。
        </Text>
      </Stack>
    </Modal>
  );
}

/** ＋ グループ。 */
export function CreateGroupModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reset = () => {
    setIds([]);
    setName("");
    setErr(null);
  };
  const submit = async () => {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    const e = await createGroup(ids, name);
    setBusy(false);
    if (e) setErr(e);
    else {
      reset();
      onClose();
    }
  };
  return (
    <Modal opened={opened} onClose={() => (reset(), onClose())} title="👥 グループ DM を作る" centered zIndex={1000}>
      <Stack gap="sm">
        <MemberPicker open={opened} exclude={new Set()} value={ids} onChange={setIds} />
        <TextInput
          label="グループ名（任意）"
          placeholder="付けなければメンバーの名前で出ます"
          value={name}
          maxLength={MAX_NAME * 2}
          onChange={(e) => setName(e.currentTarget.value)}
        />
        {err && (
          <Text size="xs" c="red">
            {err}
          </Text>
        )}
        <Text size="xs" c="dimmed">
          メンバーなら誰でも人を追加できます。外せるのは作った人だけです。発言は 30 日で消えます。
        </Text>
        <MGroup justify="flex-end">
          <Button variant="default" onClick={() => (reset(), onClose())}>
            やめる
          </Button>
          <Button color="green" onClick={() => void submit()} loading={busy} disabled={ids.length === 0}>
            作る
          </Button>
        </MGroup>
      </Stack>
    </Modal>
  );
}

function Header({ g, onMembers }: { g: Group; onMembers: () => void }) {
  return (
    <MGroup gap={8} px="sm" py={8} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
      <ActionIcon variant="subtle" color="gray" onClick={() => (closeGroup(), openDmList())} aria-label="戻る">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </ActionIcon>
      <GroupIcon size={26} photo={g.photo} />
      <UnstyledButton onClick={onMembers} style={{ flex: 1, minWidth: 0 }} aria-label="メンバーと設定">
        <Text fw={600} size="sm" truncate>
          {g.title}
          <Text span size="xs" c="dimmed" fw={400}>
            {" "}
            ({g.member_count}){g.muted ? " 🔕" : ""}
          </Text>
        </Text>
      </UnstyledButton>
      <Button size="compact-xs" variant="light" color="gray" onClick={onMembers} data-cx="gdm-members-button">
        メンバー
      </Button>
      <ActionIcon variant="subtle" color="gray" onClick={() => (closeGroup(), closeDm())} aria-label="閉じる">
        ✕
      </ActionIcon>
    </MGroup>
  );
}

export function GroupThread({ s }: { s: GdmSnapshot }) {
  const g = s.current!;
  const [draft, setDraft] = useState("");
  const [members, setMembers] = useState(false);
  const picker = useDmPhotoPicker();
  // 送れなかった写真（大きすぎ・ログイン切れなど）は本文と一緒に入力欄へ戻る。
  const put = picker.put;
  useEffect(
    () =>
      onGroupRestore((r) => {
        setDraft((cur) => cur || r.body);
        put(r.photos);
      }),
    [put]
  );
  const drop = useDmPhotoDrop(picker, s.canSend && !members);
  const kit = useDmChatKit();
  const [editingId, setEditingId] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // ↩️ 返信: 入力欄の先頭に @名前（チャットの replyChatTo と同じ）
  const replyTo = (name: string) => {
    const token = mentionToken(name);
    setDraft((cur) => (cur.startsWith(token) ? cur : token + cur.replace(/^\s+/, "")));
    requestAnimationFrame(() => {
      const ta = inputRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  };
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [s.messages.length, g.id]);
  const canSend = (!!draft.trim() || picker.photos.length > 0) && draft.length <= MAX_BODY && picker.busy === 0;
  const send = () => {
    if (!canSend) return;
    const text = draft;
    setDraft("");
    void sendGroupText(text, picker.take());
  };
  if (members) return <GroupMembers g={g} onBack={() => setMembers(false)} />;
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }} {...drop.handlers}>
      <DmDropOverlay show={drop.over} />
      <Header g={g} onMembers={() => setMembers(true)} />
      <ScrollArea style={{ flex: 1 }} viewportRef={viewport}>
        <Stack gap={6} p="sm">
          {s.loading && s.messages.length === 0 ? (
            <MGroup justify="center" py="lg">
              <Loader size="sm" />
            </MGroup>
          ) : s.messages.length === 0 ? (
            <Text size="sm" c="dimmed" ta="center" py="lg">
              グループ DM（30 日で消えます）
            </Text>
          ) : (
            s.messages.map((m, i) => (
              <GBubble
                key={m.client_id ?? m.id}
                m={m}
                prev={s.messages[i - 1]}
                editing={editingId === m.id}
                onToggleReaction={kit && m.id > 0 && m.kind === "text" ? (emoji) => void toggleGroupReaction(m.id, emoji, kit.myName) : undefined}
                onReply={!m.is_author && !m.is_beagle && m.from_name && s.canSend ? () => replyTo(m.from_name!) : undefined}
                onEdit={m.is_author && m.id > 0 && !m.pending && !m.failed ? () => setEditingId(m.id) : undefined}
                onSaveEdit={async (text) => {
                  const err = await editGroupText(m.id, text);
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
          <MGroup gap={6} align="flex-end" wrap="nowrap">
            <DmPhotoButton picker={picker} />
            <Textarea
              ref={inputRef}
              style={{ flex: 1 }}
              autosize
              minRows={1}
              maxRows={6}
              value={draft}
              placeholder={g.beagle ? `${g.title} へ（@ビーグル で質問・要約。30 日で消えます）` : `${g.title} へ（30 日で消えます）`}
              aria-label="グループ DM の本文"
              error={draft.length > MAX_BODY ? `${MAX_BODY} 文字までです` : undefined}
              onChange={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => void handleComposerKeyDown(e, { onSend: send })}
              onPaste={picker.onPaste}
              data-cx="gdm-input"
            />
            <Button color="green" onClick={send} disabled={!canSend}>
              送信
            </Button>
          </MGroup>
          </>
        ) : (
          <Text size="xs" c="dimmed" ta="center">
            このグループにはまだ送れません
          </Text>
        )}
      </Box>
    </div>
  );
}

function GBubble({
  m,
  prev,
  editing,
  onToggleReaction,
  onReply,
  onEdit,
  onSaveEdit,
  onCancelEdit,
}: {
  m: GMessage;
  prev?: GMessage;
  editing: boolean;
  onToggleReaction?: (emoji: string) => void;
  onReply?: () => void;
  onEdit?: () => void;
  onSaveEdit: (text: string) => Promise<string | null>;
  onCancelEdit: () => void;
}) {
  if (m.kind === "system") {
    return (
      <Text size="xs" c="dimmed" ta="center" py={2} data-cx="gdm-system">
        {m.body}
      </Text>
    );
  }
  const mine = m.is_author;
  // 同じ人が続けて話したら名前とアイコンは最初だけ
  const showName = !mine && (!prev || prev.kind === "system" || prev.from_id !== m.from_id);
  const actions = (
    <DmActions reactions={m.reactions ?? []} onToggleReaction={onToggleReaction} replyName={m.from_name} onReply={onReply} onEdit={onEdit} />
  );
  return (
    <div style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", gap: 6, opacity: m.pending ? 0.6 : 1 }}>
      {!mine && (
        <div style={{ width: 26, flexShrink: 0 }}>
          {showName &&
            (m.is_beagle ? (
              <Avatar size={26} radius="xl" color="yellow" aria-hidden>
                🐶
              </Avatar>
            ) : (
              <SmallAvatar src={m.from_avatar} name={m.from_name} />
            ))}
        </div>
      )}
      <div style={{ maxWidth: "78%", display: "flex", flexDirection: "column", alignItems: mine ? "flex-end" : "flex-start" }}>
        {showName && (
          <Text size="xs" c="dimmed" mb={2}>
            {m.from_name ?? "会員"}
          </Text>
        )}
        {editing ? (
          <>
            {(m.images?.length ?? 0) > 0 && (
              <div style={{ marginBottom: 6 }}>
                <DmImageGrid urls={m.images} />
              </div>
            )}
            <DmEditBox initial={m.body} allowEmpty={(m.images?.length ?? 0) > 0} maxLength={MAX_BODY} onSave={onSaveEdit} onCancel={onCancelEdit} />
          </>
        ) : (
        <MGroup gap={4} align="center" wrap="nowrap" justify={mine ? "flex-end" : "flex-start"} style={{ maxWidth: "100%" }}>
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
        </MGroup>
        )}
        <MGroup gap={6}>
          {m.failed ? (
            <>
              <Text size="xs" c="red">
                送信できませんでした
              </Text>
              <Button size="compact-xs" variant="subtle" onClick={() => retryGroupText(m)}>
                再送
              </Button>
              <Button size="compact-xs" variant="subtle" color="gray" onClick={() => discardGroupText(m)}>
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
        </MGroup>
      </div>
    </div>
  );
}

function GroupMembers({ g, onBack }: { g: Group; onBack: () => void }) {
  const [name, setName] = useState(g.name ?? "");
  const [adding, setAdding] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ id: string; name: string } | null>(null);
  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setErr(null);
    const e = await fn();
    setBusy(false);
    if (e) setErr(e);
    return !e;
  };
  return (
    <>
      <MGroup gap={8} px="sm" py={8} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <ActionIcon variant="subtle" color="gray" onClick={onBack} aria-label="戻る">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </ActionIcon>
        <Text fw={600} size="sm" style={{ flex: 1 }} truncate>
          メンバーと設定
        </Text>
      </MGroup>
      <ScrollArea style={{ flex: 1 }}>
        <Stack gap="md" p="sm">
          <MGroup gap={6} align="flex-end" wrap="nowrap">
            <TextInput
              style={{ flex: 1 }}
              label="グループ名"
              placeholder="付けなければメンバーの名前で出ます"
              value={name}
              maxLength={MAX_NAME * 2}
              onChange={(e) => setName(e.currentTarget.value)}
            />
            <Button variant="light" color="green" disabled={busy || (name.trim() || null) === g.name} onClick={() => void run(() => renameGroup(g.id, name))}>
              変える
            </Button>
          </MGroup>
          <MGroup gap="sm" wrap="nowrap">
            <GroupIcon size={56} photo={g.photo} />
            <Stack gap={4}>
              <Text size="sm" fw={600}>
                グループの写真
              </Text>
              <MGroup gap={6}>
                <Button size="compact-xs" variant="light" color="green" disabled={busy} onClick={() => photoInput.current?.click()} data-cx="gdm-photo">
                  {g.photo ? "写真を変える" : "写真を設定"}
                </Button>
                {g.photo && (
                  <Button size="compact-xs" variant="subtle" color="gray" disabled={busy} onClick={() => void run(() => removeGroupPhoto(g.id))}>
                    外す
                  </Button>
                )}
              </MGroup>
              <input
                ref={photoInput}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(e) => {
                  const f = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  if (f) void run(() => setGroupPhoto(g.id, f));
                }}
              />
            </Stack>
          </MGroup>
          <Switch
            label="🔕 このグループの通知を切る"
            checked={g.muted}
            disabled={busy}
            onChange={(e) => void run(() => setGroupMuted(g.id, e.currentTarget.checked))}
            data-cx="gdm-mute"
          />
          <Switch
            label="🐶 ビーグルを呼べるようにする"
            description="@ビーグル で質問・要約できます。答えはメンバー全員に見えます。入る前の流れも、新しく入った人に要約で伝えます。切り替えるとグループに知らせます。"
            checked={!!g.beagle}
            disabled={busy}
            onChange={(e) => void run(() => setGroupBeagle(g.id, e.currentTarget.checked))}
            data-cx="gdm-beagle"
          />
          <Box>
            <Text size="sm" fw={600} mb={4}>
              メンバー（{g.member_count}）
            </Text>
            <Stack gap={4}>
              {g.members.map((m) => (
                <MGroup key={m.user_id} gap={8} wrap="nowrap">
                  <SmallAvatar src={m.avatar} name={m.name} />
                  <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                    {m.name ?? "会員"}
                    {m.is_me && (
                      <Text span size="xs" c="dimmed">
                        {" "}
                        （あなた）
                      </Text>
                    )}
                    {m.is_creator && (
                      <Text span size="xs" c="dimmed">
                        {" "}
                        作った人
                      </Text>
                    )}
                  </Text>
                  {g.is_creator && !m.is_creator && (
                    <Button size="compact-xs" variant="subtle" color="red" disabled={busy} onClick={() => setConfirmRemove({ id: m.user_id, name: m.name ?? "会員" })}>
                      外す
                    </Button>
                  )}
                </MGroup>
              ))}
            </Stack>
          </Box>
          <Stack gap={6}>
            <MemberPicker open exclude={new Set(g.members.map((m) => m.user_id))} value={adding} onChange={setAdding} />
            <MGroup justify="flex-end">
              <Button
                variant="light"
                color="green"
                disabled={busy || adding.length === 0}
                onClick={() => void run(() => addGroupMembers(g.id, adding)).then((ok) => ok && setAdding([]))}
              >
                追加する
              </Button>
            </MGroup>
          </Stack>
          {err && (
            <Text size="xs" c="red">
              {err}
            </Text>
          )}
          <Button variant="subtle" color="red" onClick={() => setConfirmLeave(true)} data-cx="gdm-leave">
            このグループから抜ける
          </Button>
        </Stack>
      </ScrollArea>
      <Modal opened={confirmLeave} onClose={() => setConfirmLeave(false)} title="グループから抜けますか？" centered zIndex={1000}>
        <Text size="sm" mb="md">
          抜けると、このグループの発言は見られなくなります。もう一度入るには、メンバーに追加してもらう必要があります。
        </Text>
        <MGroup justify="flex-end">
          <Button variant="default" onClick={() => setConfirmLeave(false)}>
            やめる
          </Button>
          <Button
            color="red"
            loading={busy}
            onClick={() =>
              void run(() => leaveGroup(g)).then((ok) => {
                setConfirmLeave(false);
                if (ok) openDmList();
              })
            }
          >
            抜ける
          </Button>
        </MGroup>
      </Modal>
      <Modal opened={!!confirmRemove} onClose={() => setConfirmRemove(null)} title={`${confirmRemove?.name ?? ""} さんを外しますか？`} centered zIndex={1000}>
        <MGroup justify="flex-end">
          <Button variant="default" onClick={() => setConfirmRemove(null)}>
            やめる
          </Button>
          <Button color="red" loading={busy} onClick={() => confirmRemove && void run(() => removeGroupMember(g.id, confirmRemove.id, false)).then(() => setConfirmRemove(null))}>
            外す
          </Button>
        </MGroup>
      </Modal>
    </>
  );
}

async function leaveGroup(g: Group): Promise<string | null> {
  const me = g.members.find((m) => m.is_me);
  if (!me) return "抜けられませんでした（もう一度試してください）";
  return removeGroupMember(g.id, me.user_id, true);
}
