"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Group, Popover, Text, UnstyledButton } from "@mantine/core";

/**
 * Reactions on posts and chat messages.
 *
 * drikin 2026-09-25: 「今まで意図的に投稿やコメントに対してリアクションできない
 * ような設計にしてたんですけど、やっぱりちょっと寂しい感じがするので、設計を
 * 見直してほしい」— the card previously rendered 返信 only (see the comment that
 * used to sit above the action row), so `onLike` was plumbed through every
 * component but never drawn.
 *
 * Shape of the interaction, as chosen by drikin:
 *   - one tap on ❤️ reacts immediately (the old like button's feel, preserved)
 *   - a "＋" button beside it opens the picker for any other emoji
 *   - custom emoji can be registered by any member, from an uploaded image
 */

export type ReactionSummary = {
  emoji: string;
  count: number;
  mine: boolean;
  reactors: string[];
};

export type CustomEmoji = {
  id: number;
  name: string;
  imageUrl: string;
  createdBy: string;
  createdAt: string;
};

/** The quick row at the top of the picker. Ordered by how often these are
 *  actually used in chat, not by Unicode order. */
const QUICK_EMOJIS = [
  "❤️", "👍", "🎉", "😂", "🙏", "🔥", "👏", "😮", "😢", "🤔", "💯", "✨",
];

/** The full picker set. Reuses the chat composer's hand-picked list so the two
 *  pickers feel like the same product rather than two different emoji sets. */
const PICKER_EMOJIS = [
  "😀","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","😉","😍","😘","😜","🤪","😝",
  "😎","🤓","🥳","😏","😌","😴","🤤","😪","😷","🤒","🤕","🤢","🤮","🥴","😵","🤯",
  "😤","😠","😡","🤬","😭","😢","😱","😨","😰","😥","😓","🫡","🤝","👍","👎","👌",
  "✌️","🤞","🙏","👏","💪","🤙","👋","🤌","🖐️","✋","🤚","👈","👉","👆","👇","🏆",
  "🔥","❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💯","💥","✨","⭐","🌟","💫",
  "🎉","🎊","🎁","🎂","🍰","🍺","🍻","🥂","☕","🍵","🍜","🍣","🍩","🍪","🍎","🍉",
  "🚀","🤔","🥇","🗽","🎬","📷","🎧","🎮","💻","📱","⌚","💾","☁️","🌧️","☀️","🌙",
  "🌈","⚡","❄️","🚗","🚕","✈️","🏠","🌸","🐶","🐱","🦊","🐻","🐼","🐨","🐸","🐝",
  "🦄","🐙","🍀","🌍","⚽","🏀","🎯","🎲","🎳","🎹","🎸","🥁","🎨","🧸","🪙","💰",
  "💎","⏰","📌","🔔","🔒","✅","❌","⚠️","❓","❗","💬","📢","🗯️","🧦",
];

/** True when `emoji` is a ":name:" reference to a custom emoji. */
export function isCustomRef(emoji: string): boolean {
  return emoji.startsWith(":") && emoji.endsWith(":") && emoji.length > 2;
}

/** Render one reaction value: a custom emoji as an <img>, otherwise the glyph. */
export function ReactionGlyph({
  emoji,
  customEmojis,
  size = 16,
}: {
  emoji: string;
  customEmojis: CustomEmoji[];
  size?: number;
}) {
  if (isCustomRef(emoji)) {
    const name = emoji.slice(1, -1);
    const found = customEmojis.find((c) => c.name === name);
    if (!found) {
      // The emoji was deleted while a reaction still referenced it. Show the
      // name rather than a broken image so the chip stays readable.
      return <span style={{ fontSize: size * 0.75, opacity: 0.6 }}>:{name}:</span>;
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={found.imageUrl}
        alt={`:${name}:`}
        title={`:${name}:`}
        width={size}
        height={size}
        style={{ display: "block", objectFit: "contain" }}
      />
    );
  }
  return <span style={{ fontSize: size, lineHeight: 1 }}>{emoji}</span>;
}

/**
 * The reaction row under a post or chat message.
 *
 * `reactions` is the aggregate for this target; `onToggle` performs the write
 * and is expected to update the parent's state optimistically.
 */
export function ReactionBar({
  reactions,
  customEmojis,
  onToggle,
  onRegisterEmoji,
  compact,
}: {
  reactions: ReactionSummary[];
  customEmojis: CustomEmoji[];
  onToggle: (emoji: string) => void;
  /** Register a new custom emoji. Omitted for viewers who cannot (logged out). */
  onRegisterEmoji?: (name: string, file: File) => Promise<void>;
  /** Tighter spacing for chat bubbles. */
  compact?: boolean;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const pick = (emoji: string) => {
    onToggle(emoji);
    setPickerOpen(false);
  };

  const submitRegister = async () => {
    if (!onRegisterEmoji || !file || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onRegisterEmoji(name.trim(), file);
      setName("");
      setFile(null);
      if (fileRef.current) fileRef.current.value = "";
      setRegisterOpen(false);
    } catch (e: any) {
      setError(e?.message || "登録に失敗しました");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group gap={compact ? 4 : 6} wrap="wrap" align="center" data-cx="reaction-bar">
      {reactions.map((r) => (
        <UnstyledButton
          key={r.emoji}
          onClick={() => onToggle(r.emoji)}
          aria-pressed={r.mine}
          data-reaction={r.emoji}
          data-mine={r.mine ? "1" : "0"}
          title={r.reactors.length ? r.reactors.join(", ") : undefined}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: compact ? "1px 6px" : "2px 8px",
            borderRadius: 999,
            fontSize: 12,
            lineHeight: 1.4,
            border: `1px solid ${r.mine ? "var(--text-green)" : "var(--border-default)"}`,
            background: r.mine ? "var(--bg-tinted)" : "transparent",
            color: "var(--text-primary)",
          }}
        >
          <ReactionGlyph emoji={r.emoji} customEmojis={customEmojis} size={compact ? 14 : 15} />
          <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>{r.count}</span>
        </UnstyledButton>
      ))}

      {/* One-tap heart: the primary action, always visible. */}
      <UnstyledButton
        onClick={() => onToggle("❤️")}
        aria-label="ハートでリアクション"
        data-cx="reaction-heart"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: compact ? 24 : 26,
          height: compact ? 24 : 26,
          borderRadius: 999,
          border: "1px solid var(--border-default)",
          color: "var(--text-secondary)",
        }}
      >
        <span style={{ fontSize: compact ? 13 : 14, lineHeight: 1 }}>❤️</span>
      </UnstyledButton>

      {/* "＋" opens the picker. drikin chose this over long-press/right-click
       *  because it is discoverable — a hidden gesture would leave the feature
       *  invisible to exactly the people who asked for it. */}
      <Popover
        opened={pickerOpen}
        onChange={setPickerOpen}
        position="top-start"
        shadow="md"
        withinPortal
        width={320}
      >
        <Popover.Target>
          <UnstyledButton
            onClick={() => setPickerOpen((o) => !o)}
            aria-label="他の絵文字でリアクション"
            data-cx="reaction-add"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: compact ? 24 : 26,
              height: compact ? 24 : 26,
              borderRadius: 999,
              border: "1px solid var(--border-default)",
              color: "var(--text-secondary)",
              fontSize: 15,
              lineHeight: 1,
            }}
          >
            ＋
          </UnstyledButton>
        </Popover.Target>
        <Popover.Dropdown p="xs">
          <Text size="xs" fw={700} c="dimmed" mb={6}>
            よく使う
          </Text>
          <Group gap={2} mb="xs">
            {QUICK_EMOJIS.map((e) => (
              <UnstyledButton
                key={`q-${e}`}
                onClick={() => pick(e)}
                aria-label={`${e} でリアクション`}
                style={{ fontSize: 20, padding: 4, borderRadius: 6, lineHeight: 1 }}
              >
                {e}
              </UnstyledButton>
            ))}
          </Group>

          {customEmojis.length > 0 && (
            <>
              <Text size="xs" fw={700} c="dimmed" mb={6}>
                カスタム
              </Text>
              <Group gap={2} mb="xs">
                {customEmojis.map((c) => (
                  <UnstyledButton
                    key={`c-${c.id}`}
                    onClick={() => pick(`:${c.name}:`)}
                    aria-label={`:${c.name}: でリアクション`}
                    title={`:${c.name}:`}
                    style={{ padding: 4, borderRadius: 6, lineHeight: 0 }}
                  >
                    <ReactionGlyph emoji={`:${c.name}:`} customEmojis={customEmojis} size={20} />
                  </UnstyledButton>
                ))}
              </Group>
            </>
          )}

          <Text size="xs" fw={700} c="dimmed" mb={6}>
            すべて
          </Text>
          <Box
            style={{
              maxHeight: 180,
              overflowY: "auto",
              display: "grid",
              gridTemplateColumns: "repeat(8, 1fr)",
              gap: 2,
            }}
          >
            {PICKER_EMOJIS.map((e) => (
              <UnstyledButton
                key={`p-${e}`}
                onClick={() => pick(e)}
                aria-label={`${e} でリアクション`}
                style={{ fontSize: 18, padding: 3, borderRadius: 6, lineHeight: 1 }}
              >
                {e}
              </UnstyledButton>
            ))}
          </Box>

          {onRegisterEmoji && (
            <Box mt="xs" pt="xs" style={{ borderTop: "1px solid var(--border-default)" }}>
              {registerOpen ? (
                <Box>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/gif,image/webp,image/jpeg"
                    onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                    style={{ fontSize: 12, width: "100%" }}
                    aria-label="絵文字の画像"
                  />
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="名前（英小文字・数字・_）"
                    aria-label="絵文字の名前"
                    style={{
                      width: "100%",
                      marginTop: 6,
                      padding: "4px 8px",
                      fontSize: 12,
                      borderRadius: 6,
                      border: "1px solid var(--border-default)",
                      background: "transparent",
                      color: "var(--text-primary)",
                    }}
                  />
                  {error && (
                    <Text size="xs" c="red" mt={4}>
                      {error}
                    </Text>
                  )}
                  <Group gap={6} mt={6}>
                    <UnstyledButton
                      onClick={submitRegister}
                      disabled={busy || !file || !name.trim()}
                      style={{
                        fontSize: 12,
                        padding: "4px 10px",
                        borderRadius: 6,
                        background: "var(--text-green)",
                        color: "#fff",
                        opacity: busy || !file || !name.trim() ? 0.5 : 1,
                      }}
                    >
                      {busy ? "登録中…" : "登録"}
                    </UnstyledButton>
                    <UnstyledButton
                      onClick={() => {
                        setRegisterOpen(false);
                        setError(null);
                      }}
                      style={{ fontSize: 12, padding: "4px 10px", color: "var(--text-secondary)" }}
                    >
                      キャンセル
                    </UnstyledButton>
                  </Group>
                </Box>
              ) : (
                <UnstyledButton
                  onClick={() => setRegisterOpen(true)}
                  data-cx="emoji-register"
                  style={{ fontSize: 12, color: "var(--text-secondary)" }}
                >
                  ＋ カスタム絵文字を登録
                </UnstyledButton>
              )}
            </Box>
          )}
        </Popover.Dropdown>
      </Popover>
    </Group>
  );
}

/**
 * Fetch reactions for many targets at once and keep them in state.
 *
 * Batched because the feed renders 50 posts: one request per post would be 50
 * round-trips on every load. Returns a map plus a setter the caller uses after
 * a toggle so the UI updates without a refetch.
 */
export function useReactions(targetType: "post" | "chat", ids: number[]) {
  const [map, setMap] = useState<Record<number, ReactionSummary[]>>({});
  const key = ids.join(",");

  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    fetch(`/api/reactions?targetType=${targetType}&ids=${key}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const next: Record<number, ReactionSummary[]> = {};
        for (const [k, v] of Object.entries(d.reactions ?? {})) {
          next[Number(k)] = v as ReactionSummary[];
        }
        setMap(next);
      })
      .catch(() => {
        /* reactions are decorative — a failure must not break the feed */
      });
    return () => {
      cancelled = true;
    };
  }, [targetType, key]);

  const setFor = useCallback((id: number, list: ReactionSummary[]) => {
    setMap((prev) => ({ ...prev, [id]: list }));
  }, []);

  return { reactions: map, setFor };
}

/** Load the custom emoji catalogue once per page. */
export function useCustomEmojis() {
  const [emojis, setEmojis] = useState<CustomEmoji[]>([]);
  const reload = useCallback(() => {
    fetch("/api/emojis", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setEmojis(d.emojis ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    reload();
  }, [reload]);
  return { emojis, reload };
}
