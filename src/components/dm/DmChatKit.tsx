"use client";
/* ✉️👥 DM をチャットと同じ機能に（docs/dm-chat-parity-spec.md、オーナー 2026-11-08「チャットとDMで機能を同じにして」）。
 *
 *   DmChatKitProvider  page.tsx がチャットの部品（本文の描き方・カスタム絵文字・自分の名前）を渡す
 *   DmBody             本文: URL を押せる・B-guru の投稿リンクはページの中で開く・@名前を強調（チャットの renderChatBody）
 *   DmActions          吹き出しの横: 😀 リアクション・↩️ 返信（グループだけ）・✏️ 編集（自分の発言）。チャットと同じ並びと出し方
 *   DmEditBox          直す欄（Enter で保存・Esc でやめる。チャットの編集と同じ）
 * 見た目と操作はチャット（page.tsx）に合わせる。 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ActionIcon, Box, Button, Group, Text, Textarea } from "@mantine/core";
import { ReactionBar, type CustomEmoji, type ReactionSummary } from "@/components/ReactionBar";

export type DmChatKit = {
  /** チャットと同じ本文の描き方（リンク・投稿リンク・@メンション）。 */
  renderBody: (body: string) => ReactNode;
  customEmojis: CustomEmoji[];
  onRegisterEmoji?: (name: string, file: File) => Promise<void>;
  onDeleteEmoji?: (id: number) => Promise<void>;
  /** 楽観的に出すリアクションの自分の名前（表示名。メールは出さない）。 */
  myName: string;
};

const Ctx = createContext<DmChatKit | null>(null);
export const DmChatKitProvider = Ctx.Provider;
export const useDmChatKit = (): DmChatKit | null => useContext(Ctx);

export function DmBody({ body }: { body: string }) {
  const kit = useDmChatKit();
  return <>{kit ? kit.renderBody(body) : body}</>;
}

const touchDevice = (): boolean =>
  typeof window !== "undefined" && (navigator.maxTouchPoints > 0 || matchMedia("(hover: none)").matches);

/** 吹き出しの横のボタン（チャットと同じ: タッチ端末は常に、デスクトップはホバーで。リアクションがあれば常に）。 */
export function DmActions({
  reactions,
  onToggleReaction,
  replyName,
  onReply,
  onEdit,
}: {
  reactions: ReactionSummary[];
  onToggleReaction?: (emoji: string) => void;
  /** グループの他人の発言だけ（1 対 1 は相手が決まっているので出さない）。 */
  replyName?: string | null;
  onReply?: () => void;
  /** 自分の発言だけ。 */
  onEdit?: () => void;
}) {
  const kit = useDmChatKit();
  const touch = touchDevice();
  if (!onToggleReaction && !onReply && !onEdit) return null;
  return (
    <Box
      data-cx="dm-actions"
      style={{ display: "flex", alignItems: "center", gap: 2, opacity: touch ? 1 : reactions.length > 0 ? 1 : undefined, transition: "opacity 0.12s ease" }}
      className={touch ? undefined : "bguru-chat-actions"}
    >
      {onToggleReaction && kit && (
        <ReactionBar
          reactions={reactions}
          customEmojis={kit.customEmojis}
          onToggle={onToggleReaction}
          onRegisterEmoji={kit.onRegisterEmoji}
          onDeleteEmoji={kit.onDeleteEmoji}
          compact
        />
      )}
      {onReply && replyName && (
        <ActionIcon size="xs" variant="subtle" color="gray" aria-label={`${replyName} さんに返信`} title={`${replyName} さんに返信（@メンション）`} onClick={onReply}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </ActionIcon>
      )}
      {onEdit && (
        <ActionIcon size="xs" variant="subtle" color="gray" aria-label="編集" title="タイポを修正" onClick={onEdit}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
        </ActionIcon>
      )}
    </Box>
  );
}

export function EditedMark() {
  return (
    <Text size="xs" c="green.7">
      編集済み
    </Text>
  );
}

/** 直す欄。本文だけ（写真はそのまま）。写真があれば空でも保存できる。 */
export function DmEditBox({
  initial,
  allowEmpty,
  onSave,
  onCancel,
  maxLength,
}: {
  initial: string;
  allowEmpty: boolean;
  /** エラー文を返す（成功は null）。 */
  onSave: (text: string) => Promise<string | null>;
  onCancel: () => void;
  maxLength: number;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const can = !busy && (allowEmpty || text.trim().length > 0) && text.trim() !== initial.trim();
  const save = async () => {
    if (!can) return;
    setBusy(true);
    const err = await onSave(text);
    setBusy(false);
    if (err) setError(err);
  };
  return (
    <Box style={{ background: "var(--bg-surface)", border: "1px solid var(--border-green)", borderRadius: 14, padding: 6, width: "100%", minWidth: 220 }}>
      <Textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        maxLength={maxLength}
        autosize
        minRows={1}
        maxRows={6}
        placeholder="編集内容（Enter で保存・Esc でやめる）"
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          }
        }}
        data-cx="dm-edit-input"
      />
      {error && (
        <Text size="xs" c="red" mt={4}>
          {error}
        </Text>
      )}
      <Group gap={6} justify="flex-end" mt={6}>
        <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
          キャンセル
        </Button>
        <Button size="xs" onClick={() => void save()} disabled={!can} loading={busy}>
          保存
        </Button>
      </Group>
    </Box>
  );
}
