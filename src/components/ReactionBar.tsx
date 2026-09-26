"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Box, Group, Popover, Text, Tooltip, UnstyledButton } from "@mantine/core";

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

/**
 * The "add reaction" affordance: a monochrome smiley with a small plus, the
 * same idea as Slack's. drikin 2026-09-25: 「プラスのアイコンはちょっとわかり
 * にくいので、モノクロの絵文字っぽいやつ、Slack みたいなやつがいいかも」。
 *
 * Inline SVG with `currentColor` (not an emoji glyph) so it stays monochrome and
 * inherits the button's colour, matching the other card icons.
 */
export function AddReactionIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {/* face */}
      <circle cx="10.5" cy="12" r="7.5" />
      {/* eyes */}
      <line x1="8" y1="10" x2="8" y2="10.01" />
      <line x1="13" y1="10" x2="13" y2="10.01" />
      {/* smile */}
      <path d="M7.5 14.2a3.6 3.6 0 0 0 6 0" />
      {/* plus, outside the face so it reads as "add" */}
      <line x1="19" y1="4" x2="19" y2="9" />
      <line x1="16.5" y1="6.5" x2="21.5" y2="6.5" />
    </svg>
  );
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
 * Tooltip body for a reaction chip: the emoji, then who reacted.
 *
 * drikin 2026-09-25: 「リアクションのアイコンにマウスオーバーしたら、誰がリアクション
 * したかもわかるようにした方が良くないですか？」。
 *
 * Names are shown as a comma-joined list rather than one per line: a popular
 * reaction can have dozens of reactors, and a 30-line tooltip is worse than a
 * wrapped sentence. The count is repeated in the header so the tooltip still
 * answers "how many" when the list is truncated by the viewport.
 */
export function ReactionWhoList({
  emoji,
  reactors,
  count,
  customEmojis,
}: {
  emoji: string;
  reactors: string[];
  /** ★ The true number of reactors. `reactors` is capped at REACTOR_LIMIT, so
   *  its length is NOT the count — using it made the tooltip say "12人" for a
   *  chip showing 14 (おもち 2026-09-26). */
  count: number;
  customEmojis: CustomEmoji[];
}) {
  // ★ 名前リストは上限で切られているので、切られている時は「他N人」を出す。
  //   黙って少ない人数を出すと、アイコンの数字と食い違って嘘になる。
  const hidden = Math.max(0, count - reactors.length);
  return (
    <Box data-cx="reaction-who" style={{ maxWidth: 260 }}>
      <Group gap={6} align="center" wrap="nowrap" mb={reactors.length ? 4 : 0}>
        <ReactionGlyph emoji={emoji} customEmojis={customEmojis} size={14} />
        <Text size="xs" fw={700}>
          {count}人
        </Text>
      </Group>
      {reactors.length > 0 && (
        <Text size="xs" style={{ lineHeight: 1.5, wordBreak: "break-word" }}>
          {reactors.join("、")}
          {hidden > 0 && (
            <Text span size="xs" c="dimmed">
              {" "}
              他{hidden}人
            </Text>
          )}
        </Text>
      )}
    </Box>
  );
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
    // `wrap="nowrap"` because this row now lives in the card's top-right action
    // group (drikin 2026-09-25) where wrapping would push the icons onto a
    // second line and collide with the author header.
    <Group gap={compact ? 4 : 6} wrap="nowrap" align="center" data-cx="reaction-bar">
      {reactions.map((r) => (
        // Hover shows WHO reacted (drikin 2026-09-25: 「リアクションのアイコンに
        // マウスオーバーしたら、誰がリアクションしたかもわかるようにした方が良く
        // ないですか？」). A Mantine Tooltip rather than the native `title` attribute:
        // `title` takes ~1s to appear, cannot be styled, and renders as a plain
        // OS tooltip that ignores the app's theme.
        <Tooltip
          key={r.emoji}
          withArrow
          openDelay={120}
          label={
            <ReactionWhoList
              emoji={r.emoji}
              reactors={r.reactors}
              count={r.count}
              customEmojis={customEmojis}
            />
          }
          disabled={r.reactors.length === 0}
        >
          <UnstyledButton
            onClick={() => onToggle(r.emoji)}
            aria-pressed={r.mine}
            aria-label={`${r.emoji} リアクション ${r.count}件`}
            data-reaction={r.emoji}
            data-mine={r.mine ? "1" : "0"}
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
        </Tooltip>
      ))}

      {/* Picker trigger. drikin 2026-09-25: 「ハートとプラスマークは機能が重複して
       * いるので、ハートは削除していいです。あとプラスのアイコンはちょっとわかり
       * にくいので、モノクロの絵文字っぽいやつ、Slack みたいなやつがいいかも」。
       *
       *  So: the separate one-tap heart is gone (the ❤️ chip in the picker's
       *  "よく使う" row covers it in one tap), and the trigger is now a
       *  monochrome smiley-with-plus — the same affordance Slack uses for
       *  "add reaction". Drawn as inline SVG (currentColor) rather than an
       *  emoji glyph so it stays monochrome and matches the other icons. */}
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
            aria-label="リアクションを追加"
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
              lineHeight: 0,
            }}
          >
            <AddReactionIcon size={compact ? 15 : 16} />
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
