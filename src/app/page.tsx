"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  AppShell,
  NavLink,
  Stack,
  Group,
  Avatar,
  Text,
  Badge,
  Button,
  Title,
  Paper,
  TextInput,
  Textarea,
  Card,
  Divider,
  ScrollArea,
  ThemeIcon,
  Box,
  Image,
  Modal,
  ActionIcon,
  Burger,
  Popover,
  Indicator,
  Loader,
  Tooltip,
  Menu,
  UnstyledButton,
  Collapse,
  useMantineColorScheme,
} from "@mantine/core";
import { mdToHtml } from "@/lib/md";

type View = "login" | "otp";

interface UrlPreview {
  url: string;
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  videoId?: string;
}

interface FeedPost {
  id: number;
  authorEmail: string;
  authorName: string | null;
  authorAvatar?: string | null;
  parentId?: number | null;
  replyCount?: number;
  replies?: FeedPost[];
  lastActivityAt?: string;
  pinnedAt?: string | null;
  recentComments?: number;
  text: string;
  images: string[];
  urlPreview: UrlPreview | null;
  likeCount: number;
  likedByMe: boolean;
  createdAt: string;
}

/** Format a timestamp in JST (primary) + PDT (secondary). e.g.
 *  "2026/8/7 20:30 JST / 04:30 PDT" */
function formatJSTPDT(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const jst = d.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const pdt = d.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${jst} JST / ${pdt} PDT`;
}

/** Return the date parts (JST) of the NEXT 18:00 JST. If it's already past
 *  18:00 JST today, returns tomorrow's date. 18:00 JST = 09:00 UTC. */
function nextJst18Date(): { y: number; mo: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const h = +p.hour;
  // If it's already >= 18:00 JST, bump to the following day's 18:00.
  const today18 = Date.UTC(+p.year, +p.month - 1, +p.day, 9);
  const target = new Date(h >= 18 ? today18 + 86400000 : today18);
  return {
    y: target.getUTCFullYear(),
    mo: target.getUTCMonth() + 1,
    d: target.getUTCDate(),
  };
}

/** Auto title for the next episode: "2026年8月10日号". */
function drinewsNextTitle(): string {
  const { y, mo, d } = nextJst18Date();
  return `${y}年${mo}月${d}日号`;
}

/** JST date string "2026-8-8" (or 2-digit padding) for grouping. */
function jstDateKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-CA", { timeZone: "Asia/Tokyo" }); // YYYY-MM-DD
}

/** Human label for a JST date key, e.g. "2026年8月8日 (土)". */
function jstDateLabel(dateKey: string): string {
  const [y, m, dd] = dateKey.split("-").map(Number);
  if (!y || !m || !dd) return dateKey;
  const d = new Date(Date.UTC(y, m - 1, dd));
  const wd = d.toLocaleDateString("ja-JP", { timeZone: "UTC", weekday: "short" });
  return `${y}年${m}月${dd}日 (${wd})`;
}

interface FeedGroup {
  dateKey: string;
  authorEmail: string;
  authorName: string;
  authorAvatar?: string | null;
  lastActivity: string;
  posts: FeedPost[]; // exactly ONE root post per group (its replies live in posts[0].replies)
}

/** Each ROOT post is its own group (main card + its replying comments). Date key
 *  comes from the post's LATEST activity (own or newest reply), so inserting a
 *  comment keeps it on the right day and bumps it to the top of the timeline. */
function groupFeed(posts: FeedPost[]): FeedGroup[] {
  return posts
    .map((p): FeedGroup | null => {
      const act = p.lastActivityAt || p.createdAt;
      const dateKey = jstDateKey(act);
      if (!dateKey) return null;
      return {
        dateKey,
        authorEmail: p.authorEmail,
        authorName: p.authorName || p.authorEmail.split("@")[0],
        authorAvatar: p.authorAvatar || null,
        lastActivity: act,
        posts: [p],
      };
    })
    .filter((g): g is FeedGroup => g !== null)
    .sort((a, b) => {
      // Pure latest-activity order. (Pins were moved to the right sidebar and
      // no longer affect timeline position.)
      return a.lastActivity < b.lastActivity
        ? 1
        : a.lastActivity > b.lastActivity
        ? -1
        : 0;
    });
}

interface DrinewsArticle {
  id: number;
  authorEmail: string;
  title: string;
  bodyMd: string;
  bodyHtml: string;
  headerImage: string | null;
  status: string;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
}

interface DrinewsComment {
  id: number;
  articleId: number;
  authorEmail: string;
  authorName: string | null;
  authorAvatar?: string | null;
  comment: string;
  createdAt: string;
}

const NAV_ITEMS: { key: string; label: string; icon: string }[] = [
  { key: "feed", label: "タイムライン", icon: "🏠" },
  { key: "episodes", label: "エピソード", icon: "🎧" },
  { key: "gallery", label: "ギャラリー", icon: "🖼️" },
  { key: "news", label: "記事", icon: "📰" },
  { key: "drinews", label: "ドリニュース", icon: "📮" },
];

// External-link menu bookmarks are DB-backed (admins manage them from the UI).
// Admin email allowlist — these members get the edit/delete/add UI.
const ADMIN_EMAILS: ReadonlySet<string> = new Set([
  "drikin@gmail.com",
  "matsuo@gmail.com",
  "zenjinishikawa@gmail.com",
]);

interface MenuLinkItem {
  id: number;
  label: string;
  icon: string;
  href: string;
}

/** Avatar that falls back to the initial-letter placeholder when the image
 * fails to load (e.g. user has no Gravatar → 404). */
function SafeAvatar({
  src,
  initial,
  size = "sm",
  radius = "xl",
  color = "green",
}: {
  src?: string | null;
  initial: string;
  size?: "xs" | "sm" | "md" | "lg";
  radius?: string;
  color?: string;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = !!src && !failed;
  return (
    <Avatar
      src={showImg ? src : undefined}
      radius={radius}
      color={color}
      size={size}
      onError={() => setFailed(true)}
    >
      {initial
        .charAt(0)
        .toUpperCase()}
    </Avatar>
  );
}


// ---- @mention support ----
interface MentionMember { email: string; name: string; avatar: string | null }

/** Highlight @mentions in post text by wrapping them in a markdown link
 *  that mdToHtml turns into <a href="#mention-name">@name</a>, styled via CSS. */
function highlightMentions(text: string, members: MentionMember[]): string {
  if (!members.length) return text;
  const nameSet = new Set(members.map(m => m.name.toLowerCase()));
  // Match @[Full Name] (bracket syntax for names with spaces) or @name (single word)
  return text
    .replace(/@\[([^\]]+)\]/g, (match, name) => {
      if (nameSet.has(name.toLowerCase())) {
        return `[@${name}](#mention-${name.toLowerCase().replace(/\s+/g, "-")})`;
      }
      return match;
    })
    .replace(/@([^\s@<\[]+)/g, (match, name) => {
      if (nameSet.has(name.toLowerCase())) {
        return `[@${name}](#mention-${name.toLowerCase()})`;
      }
      return match;
    });
}

/** Highlight search keyword in rendered HTML by wrapping matches in <mark>.
 *  Escapes regex special chars in the keyword. Only operates outside HTML tags
 *  (between > and <) to avoid corrupting attributes. */
function highlightSearchTerm(html: string, keyword: string): string {
  const kw = keyword.trim();
  if (!kw) return html;
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(${escaped})`, "gi");
  // Split by HTML tags so we only highlight text content, not attributes.
  return html.replace(/(>)([^<]+)(<)/g, (_match, openTag, text, closeTag) => {
    return openTag + text.replace(re, '<mark style="background:var(--mark-bg);color:inherit;padding:0 2px;border-radius:2px">$1</mark>') + closeTag;
  });
}

/** Textarea with @mention autocomplete. Shows a suggestion popover when the
 *  user types @ followed by characters. Selecting a member inserts @name. */
function MentionTextarea({
  value, onChange, onKeyDown, placeholder, autosize, minRows, maxRows, mb,
  maxLength, label, description, autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
  mb?: string | number;
  maxLength?: number;
  label?: string;
  description?: React.ReactNode;
  autoFocus?: boolean;
}) {
  const [members, setMembers] = useState<MentionMember[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const membersLoaded = useRef(false);

  useEffect(() => {
    if (membersLoaded.current) return;
    membersLoaded.current = true;
    fetch("/api/members")
      .then(r => r.json())
      .then(d => { if (d.members) setMembers(d.members); })
      .catch(() => {});
  }, []);

  // Detect the active @mention token. `before` is the text up to the caret;
  // `detect` extracts the last `@...` token that reaches the end of the text.
  const detect = (text: string): string | null => {
    const m = text.match(/@(\[?[^\s@\[\]]*)$/);
    return m ? m[1] : null;
  };

  // Update the mention query from the current textarea content. Prefer the
  // caret-based trigger (lets suggestions open while editing mid-text), but
  // fall back to the whole value's last @token — IME composition (Japanese
  // etc.) makes the caret position unreliable, so `@柳家` filters correctly
  // even right after the user commits 2-byte text.
  const updateQuery = (v: string) => {
    const ta = taRef.current;
    const pos = ta?.selectionStart ?? v.length;
    const before = v.slice(0, pos);
    setQuery(detect(before) ?? detect(v));
    setSuggestIndex(0);
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.currentTarget.value;
    onChange(v);
    updateQuery(v);
  };

  // Name matching is normalized so white-space never blocks an @-candidate:
  // spaces and full-width spaces are stripped from both the query and each
  // member name before comparing. A Japanese/2-byte name registered with a
  // space (e.g. 「柳家 三之助」) therefore matches whether the user types
  // `@柳家`, `@柳家三之助`, or `@柳家三`.
  const norm = (s: string) => s.toLowerCase().replace(/[\s\u3000]/g, "");
  const filtered =
    query !== null
      ? members
          .filter((m) => norm(m.name).includes(norm(query.replace(/^\[/, ""))))
          .slice(0, 6)
      : [];

  const insertMention = (member: MentionMember) => {
    const ta = taRef.current;
    if (!ta) return;
    const v = ta.value;
    const pos = ta.selectionStart;
    const before = v.slice(0, pos);
    const after = v.slice(pos);
    const mentionText = member.name.includes(" ") ? `@[${member.name}] ` : `@${member.name} `;
    const replaced = before.replace(/@([^\s@\[\]]*)$/, mentionText);
    const newVal = replaced + after;
    onChange(newVal);
    setQuery(null);
    requestAnimationFrame(() => {
      ta.focus();
      const cursorPos = replaced.length;
      ta.setSelectionRange(cursorPos, cursorPos);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // During IME composition (Japanese, Chinese, Korean, …), let the IME own
    // Enter/Arrow/Tab — otherwise the mention navigator hijacks them and the
    // user can't commit or pick IME candidates. The parent's onKeyDown guards
    // its own shortcuts against composition, so it is safe to fall through.
    if ((e.nativeEvent as any).isComposing) {
      onKeyDown?.(e);
      return;
    }
    // Mention suggestions are open — handle navigation/selection.
    // But always let modifier-key combos (Cmd/Ctrl+Enter, Shift+Enter) pass
    // through to the parent's onKeyDown so reply/whisper shortcuts work even
    // while a suggestion popup is visible.
    if (query !== null && filtered.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSuggestIndex(i => (i + 1) % filtered.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSuggestIndex(i => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      // Plain Enter or Tab selects a mention — but only without modifiers.
      if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        insertMention(filtered[suggestIndex]);
        return;
      }
      if (e.key === "Escape") {
        setQuery(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <div style={{ position: "relative" }}>
      <Textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onCompositionEnd={() => {
          // After IME commits 2-byte text (Japanese etc.), re-detect the
          // mention query from the real value — onChange may not have delivered
          // the composing text, which left the suggestion list unfiltered.
          const ta = taRef.current;
          if (ta) updateQuery(ta.value);
        }}
        placeholder={placeholder}
        autosize={autosize}
        minRows={minRows}
        maxRows={maxRows}
        mb={mb}
        maxLength={maxLength}
        label={label}
        description={description}
        autoFocus={autoFocus}
      />
      {query !== null && filtered.length > 0 && (
        <div
          style={{
            position: "absolute",
            zIndex: 1000,
            left: 0,
            right: 0,
            background: "var(--bg-surface)",
            border: "1px solid var(--border-default)",
            borderRadius: 8,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            maxHeight: 220,
            overflowY: "auto",
          }}
        >
          {filtered.map((m, i) => (
            <div
              key={m.email}
              onClick={() => insertMention(m)}
              style={{
                padding: "6px 10px",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: i === suggestIndex ? "var(--bg-suggest-active)" : "var(--bg-surface)",
              }}
              onMouseEnter={() => setSuggestIndex(i)}
            >
              <SafeAvatar src={m.avatar} initial={m.name} size="xs" />
              <Text size="sm" c="inherit">{m.name}</Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Live countdown of a pinned post's remaining 24h window. Ticks every second.
 *  Shows "あと 23:59:59" style until expiry, then renders nothing (the post
 *  will drop out of the pinned section on the next feed reload). */
function PinCountdown({ pinnedAt }: { pinnedAt: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const expiry = new Date(pinnedAt).getTime() + 24 * 60 * 60 * 1000;
  const remainMs = expiry - now;
  if (remainMs <= 0) return null;

  const totalSec = Math.floor(remainMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, "0");

  return (
    <Text size="xs" c="green.7" fw={600} style={{ fontVariantNumeric: "tabular-nums" }}>
      残り {pad(h)}:{pad(m)}:{pad(s)}
    </Text>
  );
}

/* Shared post card used both in the timeline feed and the thread view.
 * Holds the single implementation of like/reply/edit/delete/image/URL so we
 * never duplicate post UI between the timeline and thread views. */
function PostCard({
  post,
  auth,
  avatarSrc,
  isThreadRoot = false,
  showReplyButton = true,
  mentionMembers,
  searchQuery,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onWhisper,
  onEdit,
  onDelete,
  onPin,
  onPreview,
}: {
  post: FeedPost;
  auth: { email: string };
  avatarSrc?: string | null;
  isThreadRoot?: boolean;
  showReplyButton?: boolean;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number, name: string) => void;
  onWhisper?: (id: number, name: string) => void;
  onPin: (id: number) => void;
  onEdit: (post: FeedPost) => void;
  onDelete: (post: FeedPost) => void;
  onPreview: (src: string) => void;
}) {
  const CLAMP_THRESHOLD = 500;
  const [expanded, setExpanded] = useState(false);
  const needsClamp = post.text && post.text.length > CLAMP_THRESHOLD;

  return (
    <Card
      radius="md"
      withBorder
      p="md"
      shadow="sm"
      style={{ cursor: isThreadRoot ? "default" : "pointer", position: "relative" }}
      onClick={(e: React.MouseEvent) => {
        // Don't open when clicking buttons/links/images inside the card
        const t = e.target as HTMLElement;
        if (isThreadRoot) return;
        if (t.closest("button, a, input, textarea, img")) return;
        onOpenThreadReply(post.id);
      }}
    >
      {/* Own post only: small monochrome edit/delete icons floating in the
       * top-right corner of the card (absolutely positioned, no layout shift). */}

      {auth.email === post.authorEmail && (
        <Group
          gap={2}
          wrap="nowrap"
          style={{ position: "absolute", top: 6, right: 6, zIndex: 2 }}
        >
          {/* Pin is only for the ROOT (parent) post, not replies. */}
          {!post.parentId && (
            <ActionIcon
              variant={post.pinnedAt ? "light" : "subtle"}
              color={post.pinnedAt ? "green" : "gray"}
              size="sm"
              aria-label={post.pinnedAt ? "ピン解除" : "ピン"}
              onClick={() => onPin(post.id)}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill={post.pinnedAt ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
              </svg>
            </ActionIcon>
          )}
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            aria-label="編集"
            onClick={() => onEdit(post)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
            </svg>
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            aria-label="削除"
            onClick={() => onDelete(post)}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </ActionIcon>
        </Group>
      )}

      <Group gap="sm" mb={6}>
        <SafeAvatar
          src={post.authorEmail === auth.email ? avatarSrc : post.authorAvatar || undefined}
          initial={(post.authorName || post.authorEmail.split("@")[0] || "?")}
        />
        <div style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} c="inherit">
            {post.authorName || post.authorEmail.split("@")[0]}
          </Text>
          <Text size="xs" c="dimmed">
            {formatJSTPDT(post.createdAt)}
          </Text>
        </div>
      </Group>

      {post.text && (
        <div style={{ position: "relative" }}>
          <div
            className="post-body"
            dangerouslySetInnerHTML={{
              __html: highlightSearchTerm(
                mdToHtml(
                  highlightMentions(
                    needsClamp && !expanded
                      ? post.text.slice(0, CLAMP_THRESHOLD)
                      : post.text,
                    mentionMembers ?? []
                  )
                ),
                searchQuery ?? ""
              ),
            }}
          />
          {needsClamp && !expanded && (
            <div
              style={{
                position: "absolute",
                bottom: 0,
                left: 0,
                right: 0,
                height: "4em",
                background: "linear-gradient(transparent, white)",
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                paddingBottom: 4,
              }}
            >
              <Button
                variant="subtle"
                size="xs"
                onClick={(e: React.MouseEvent) => {
                  e.stopPropagation();
                  setExpanded(true);
                }}
              >
                続きを読む
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Images */}
      {post.images.length > 0 && (
        <Group
          gap="xs"
          mt="sm"
          className="w-full"
          style={{ display: "grid", gridTemplateColumns: post.images.length === 1 ? "100%" : `repeat(${Math.min(post.images.length, 3)}, 1fr)` }}
        >
          {post.images.map((src, i) => (
            <Image
              key={i}
              src={src}
              radius="md"
              style={{
                cursor: "pointer",
                width: "100%",
                maxWidth: post.images.length === 1 ? 360 : "none",
                height: "auto",
                display: "block",
              }}
              onClick={() => onPreview(src)}
            />
          ))}
        </Group>
      )}

      {/* URL preview */}
      {post.urlPreview && (
        <Paper
          mt="sm"
          p="sm"
          radius="md"
          withBorder
          component="a"
          href={post.urlPreview.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: "block", textDecoration: "none" }}
        >
          {post.urlPreview.image && (
            <Box style={{ position: "relative" }}>
              <Image
                src={post.urlPreview.image}
                radius="md"
                mb="xs"
                style={{
                  width: "100%",
                  maxWidth: post.urlPreview.videoId ? 480 : "none",
                  aspectRatio: post.urlPreview.videoId ? "16/9" : undefined,
                  objectFit: "cover",
                  display: "block",
                }}
              />
              {post.urlPreview.videoId && (
                <Box
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    pointerEvents: "none",
                  }}
                >
                  <Box
                    style={{
                      width: 52,
                      height: 52,
                      borderRadius: "50%",
                      background: "rgba(0,0,0,0.75)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 22,
                      color: "var(--bg-surface)",
                    }}
                  >
                    ▶
                  </Box>
                </Box>
              )}
            </Box>
          )}
          <Text size="sm" fw={600} c="inherit">
            {post.urlPreview.title || post.urlPreview.url}
          </Text>
          {post.urlPreview.description && (
            <Text size="xs" c="dimmed" lineClamp={2}>
              {post.urlPreview.description}
            </Text>
          )}
          <Text size="xs" c="gray" mt={4}>
            {post.urlPreview.siteName || post.urlPreview.url}
          </Text>
        </Paper>
      )}

      {/* Bottom action: 返信 only. (Whisper is available via the "+" insert
       * control between cards / inside the thread reply box — no separate
       * button on the card itself.) */}
      {showReplyButton && onReply && (
        <Group mt="sm" gap="xs">
          <Button
            size="xs"
            variant="subtle"
            color="blue"
            leftSection={<span style={{ fontSize: 13 }}>💬</span>}
            onClick={() => onReply(post.id, post.authorName || post.authorEmail.split("@")[0])}
          >
            返信{post.replyCount ? ` (${post.replyCount})` : ""}
          </Button>
        </Group>
      )}
    </Card>
  );
}

/** Shared tappable summary card for a post in the right-sidebar panels (pins &
 *  hot topics). Renders the common chrome — avatar + name header, 2-line text
 *  clamp — and a feature-specific bottom row passed as `children`. Clicking the
 *  card scrolls the timeline to that post (via `onOpen`). Keeps the pins & hot
 *  lists visually identical without duplicating the card markup. */
function SidebarPostCard({
  post,
  onOpen,
  loading,
  children,
}: {
  post: FeedPost;
  onOpen: (id: number) => void;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  const previewImg = post.images?.[0];
  return (
    <Box
      onClick={() => onOpen(post.id)}
      role="button"
      tabIndex={0}
      aria-label="タイムラインでこの投稿を表示"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(post.id);
        }
      }}
      style={{
        cursor: "pointer",
        border: "1px solid var(--border-default)",
        borderRadius: 8,
        padding: "8px 8px 8px 10px",
        background: "var(--bg-surface)",
        position: "relative",
        transition: "border-color .15s, box-shadow .15s, background .15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--border-green)";
        e.currentTarget.style.boxShadow = "0 1px 4px rgba(0,0,0,0.1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border-default)";
        e.currentTarget.style.boxShadow = "none";
      }}
    >
      <Group gap="xs" align="center" wrap="nowrap" mb={4}>
        <SafeAvatar src={post.authorAvatar} initial={post.authorName || post.authorEmail} size="xs" />
        <Text size="xs" fw={600} c="inherit" truncate style={{ flex: 1 }}>
          {post.authorName || post.authorEmail.split("@")[0]}
        </Text>
      </Group>

      {post.text ? (
        <Text size="xs" c="dimmed" lineClamp={2} mb={previewImg ? 6 : 2}>
          {post.text}
        </Text>
      ) : null}

      {children}

      {loading && (
        <Box
          aria-hidden
          data-loading-overlay="true"
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 8,
            background: "rgba(233,245,234,0.92)",
            border: "1px solid var(--border-green)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            zIndex: 5,
            cursor: "progress",
          }}
        >
          <Loader size="md" color="green" />
          <Text size="xs" c="green.8" fw={700}>
            読み込み中…
          </Text>
        </Box>
      )}
    </Box>
  );
}

/** Compact summary of a pinned post, shown in the right-sidebar panel. Clicking
 *  the card scrolls the timeline to that post (in context); the ✕ button unpins
 *  it. No link preview (user: link previews unnecessary in the sidebar). */
function PinnedCard({
  post,
  onOpen,
  onUnpin,
  canUnpin = false,
  loading,
}: {
  post: FeedPost;
  onOpen: (id: number) => void;
  onUnpin: (id: number) => void;
  canUnpin?: boolean;
  loading?: boolean;
}) {
  const replyCount = post.replyCount ?? post.replies?.length ?? 0;
  const previewImg = post.images?.[0];
  return (
    <SidebarPostCard post={post} onOpen={onOpen} loading={loading}>
      {previewImg && (
        <Image
          src={previewImg}
          alt=""
          radius={6}
          style={{
            width: "100%",
            height: 140,
            objectFit: "cover",
            display: "block",
            marginBottom: 6,
          }}
        />
      )}
      <Group
        align="center"
        justify="space-between"
        gap="xs"
        wrap="nowrap"
        style={{ minHeight: 20 }}
      >
        {/* Comment count — its own line, bottom-left */}
        <Group gap={4} align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
            {replyCount}
          </Text>
        </Group>

        <Group gap="xs" align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
          {post.pinnedAt && <PinCountdown pinnedAt={post.pinnedAt} />}
          {canUnpin && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label="ピン解除"
              onClick={(e) => {
                e.stopPropagation();
                onUnpin(post.id);
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </ActionIcon>
          )}
        </Group>
      </Group>
    </SidebarPostCard>
  );
}

/** Compact summary of a hot topic (most-commented root post in the last 7 days),
 *  shown in the right-sidebar "ホットトピック" panel. Clicking scrolls the timeline
 *  to it. Displays the 7-day comment count (whispers included). */
function HotTopicCard({
  post,
  onOpen,
  loading,
}: {
  post: FeedPost;
  onOpen: (id: number) => void;
  loading?: boolean;
}) {
  const previewImg = post.images?.[0];
  const recent = post.recentComments ?? post.replyCount ?? 0;
  return (
    <SidebarPostCard post={post} onOpen={onOpen} loading={loading}>
      {previewImg && (
        <Image
          src={previewImg}
          alt=""
          radius={6}
          style={{
            width: "100%",
            height: 140,
            objectFit: "cover",
            display: "block",
            marginBottom: 6,
          }}
        />
      )}
      {/* Comment count — its own line, bottom-left (never overlaps the image) */}
      <Group gap={4} align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums" }}>
          {recent}
        </Text>
      </Group>
    </SidebarPostCard>
  );
}

/** Collapsible replies: when a post has 5+ comments, show the parent + latest 3
 *  comments with the middle ones collapsed behind a "show N hidden" toggle.
 *  Comments are in chronological ascending order (oldest first, newest at bottom).
 *  So we collapse the OLDER middle section (after parent, before the latest 3).
 *  Smooth expand/collapse animation using Mantine's Collapse + CSS transitions. */
const COLLAPSE_THRESHOLD = 4;
const VISIBLE_TAIL = 3; // latest 3 comments always visible

function CollapsibleReplies({
  replies,
  auth,
  avatarSrc,
  mentionMembers,
  searchQuery,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onWhisper,
  onEdit,
  onDelete,
  onPin,
  onPreview,
}: {
  replies: FeedPost[];
  auth: { email: string };
  avatarSrc?: string | null;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number, name: string) => void;
  onWhisper?: (id: number, name: string) => void;
  onEdit: (post: FeedPost) => void;
  onDelete: (post: FeedPost) => void;
  onPin: (id: number) => void;
  onPreview: (src: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  if (replies.length < COLLAPSE_THRESHOLD) {
    // No collapsing needed — render all replies directly
    return (
      <>
        {replies.map((rep) => (
          <ReplyBubble
            key={`rep-${rep.id}`}
            rep={rep}
            auth={auth}
            mentionMembers={mentionMembers}
            searchQuery={searchQuery}
            avatarSrc={avatarSrc}
            onOpenThread={onOpenThread}
            onOpenThreadReply={onOpenThreadReply}
            onLike={onLike}
            onEdit={onEdit}
            onDelete={onDelete}
            onPreview={onPreview}
          />
        ))}
      </>
    );
  }

  const hiddenCount = replies.length - VISIBLE_TAIL;
  const hiddenReplies = replies.slice(0, hiddenCount); // older middle section
  const visibleReplies = replies.slice(hiddenCount);   // latest 4

  return (
    <>
      {/* Toggle button — sits right after parent, before collapsed section */}
      <UnstyledButton
        onClick={() => setExpanded((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          padding: "6px 12px",
          borderRadius: 8,
          background: expanded ? "var(--bg-expanded)" : "var(--bg-subtle)",
          border: "1px solid var(--border-green-soft)",
          transition: "background 0.2s ease, border-color 0.2s ease",
          cursor: "pointer",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "var(--bg-hover)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = expanded ? "var(--bg-expanded)" : "var(--bg-subtle)";
        }}
      >
        {expanded ? (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="var(--text-green-soft)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transition: "transform 0.3s ease" }}>
              <path d="M18 15l-6-6-6 6" />
            </svg>
            <Text size="xs" c="green.7" style={{ fontWeight: 500 }}>
              閉じる
            </Text>
          </>
        ) : (
          <>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="var(--text-green-soft)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
              style={{ transition: "transform 0.3s ease" }}>
              <path d="M6 9l6 6 6-6" />
            </svg>
            <Text size="xs" c="green.7" style={{ fontWeight: 500 }}>
              {hiddenCount}件のコメントを表示
            </Text>
          </>
        )}
      </UnstyledButton>
      {/* Collapsed older replies — expands between toggle and latest 4 */}
      <Collapse expanded={expanded} transitionDuration={400} animateOpacity>
        <Stack gap={6}>
          {hiddenReplies.map((rep) => (
            <ReplyBubble
              key={`rep-${rep.id}`}
              rep={rep}
              auth={auth}
              mentionMembers={mentionMembers}
              searchQuery={searchQuery}
              avatarSrc={avatarSrc}
              onOpenThread={onOpenThread}
              onOpenThreadReply={onOpenThreadReply}
              onLike={onLike}
              onEdit={onEdit}
              onDelete={onDelete}
              onPreview={onPreview}
            />
          ))}
        </Stack>
      </Collapse>
      {/* Latest 3 replies always visible at bottom (newest at very bottom) */}
      {visibleReplies.map((rep) => (
        <ReplyBubble
          key={`rep-${rep.id}`}
          rep={rep}
          auth={auth}
          mentionMembers={mentionMembers}
          searchQuery={searchQuery}
          avatarSrc={avatarSrc}
          onOpenThread={onOpenThread}
          onOpenThreadReply={onOpenThreadReply}
          onLike={onLike}
          onEdit={onEdit}
          onDelete={onDelete}
          onPreview={onPreview}
        />
      ))}
    </>
  );
}

/** A single reply bubble with the shared green-tinted left border style. */
function ReplyBubble({
  rep,
  auth,
  avatarSrc,
  mentionMembers,
  searchQuery,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onEdit,
  onDelete,
  onPreview,
}: {
  rep: FeedPost;
  auth: { email: string };
  avatarSrc?: string | null;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onEdit: (post: FeedPost) => void;
  onDelete: (post: FeedPost) => void;
  onPreview: (src: string) => void;
}) {
  return (
    <Box
      ml={6}
      style={{
        borderLeft: "2px solid var(--border-green-soft)",
        paddingLeft: 8,
        background: "var(--bg-reply)",
        borderRadius: 8,
      }}
    >
      <PostCard
        post={rep}
        auth={auth}
        mentionMembers={mentionMembers}
        searchQuery={searchQuery}
        avatarSrc={avatarSrc}
        isThreadRoot={false}
        showReplyButton={false}
        onOpenThread={onOpenThread}
        onOpenThreadReply={() => {}}
        onLike={onLike}
        onReply={() => {}}
        onEdit={onEdit}
        onDelete={onDelete}
        onPin={() => {}}
        onPreview={onPreview}
      />
    </Box>
  );
}

/** Grouped timeline: day separators + per-author groups. Posts are shown fully
 *  expanded (no collapse/stack) inside a group framed by a slim author header. */
function TimelineFeed({
  groups,
  auth,
  avatarSrc,
  mentionMembers,
  searchQuery,
  inlineReplyFor,
  inlineReplyText,
  inlineWhisper,
  inlineReplyImages,
  inlineUploading,
  inlineReplying,
  onInlineReplyChange,
  onToggleInlineReply,
  onInlineReplySubmit,
  onInlineReplyPick,
  onRemoveInlineReplyImage,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onWhisper,
  onEdit,
  onDelete,
  onPin,
  onPreview,
}: {
  groups: FeedGroup[];
  auth: { email: string };
  avatarSrc?: string | null;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  inlineReplyFor: number | null;
  inlineReplyText: string;
  inlineWhisper?: boolean;
  inlineReplyImages: string[];
  inlineUploading: boolean;
  inlineReplying: 'comment' | 'whisper' | false;
  onInlineReplyChange: (t: string) => void;
  onToggleInlineReply: (id: number) => void;
  onInlineReplySubmit: (id: number, whisper?: boolean) => void;
  onInlineReplyPick: (files: FileList | null) => void;
  onRemoveInlineReplyImage: (i: number) => void;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number) => void;
  onWhisper?: (id: number, name: string) => void;
  onEdit: (p: FeedPost) => void;
  onDelete: (p: FeedPost) => void;
  onPin: (id: number) => void;
  onPreview: (src: string) => void;
}) {
  let lastDate = "";
  const rendered: React.ReactNode[] = [];

  for (const g of groups) {
    // ---- Day separator ----
    if (g.dateKey !== lastDate) {
      lastDate = g.dateKey;
      const isToday = g.dateKey === jstDateKey(new Date().toISOString());
      rendered.push(
        <Group key={`sep-${g.dateKey}`} align="center" mt="md" mb={4}>
          <Divider style={{ flex: 1 }} />
          <Badge
            size="lg"
            variant={isToday ? "filled" : "light"}
            color={isToday ? "green" : "gray"}
            radius="xl"
            style={{ textTransform: "none", fontWeight: 600 }}
          >
            {jstDateLabel(g.dateKey)}
            {isToday ? "（今日）" : ""}
          </Badge>
          <Divider style={{ flex: 1 }} />
        </Group>
      );
    }

    const gkey = `${g.dateKey}|${g.authorEmail}`;

    // Minimal grouping: no header/frame. A subtle green left-accent bar plus
    // tight inner spacing visually "chains" this author's consecutive posts
    // together, while a larger gap below separates them from the next author.
    // Between cards, a "+" button inserts an inline comment at that position.
    const firstOfGroup = rendered.length > 0;
    rendered.push(
      <Box
        key={gkey}
        data-post-id={g.posts[0].id}
        style={{
          borderLeft: "3px solid var(--border-green-soft)",
          borderTopLeftRadius: 8,
          borderBottomLeftRadius: 8,
          paddingLeft: 12,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          marginTop: firstOfGroup ? 20 : 0,
        }}
      >
        {g.posts.map((post, i) => (
          <Fragment key={post.id}>
            {/* The author's own card (no reply button here; "ささやく" offers a
             * quiet, in-place reply that does NOT bump the group to the top) */}
            <PostCard
              post={post}
              auth={auth}
              mentionMembers={mentionMembers}
              searchQuery={searchQuery}
              avatarSrc={avatarSrc}
              isThreadRoot={false}
              showReplyButton={false}
              onOpenThread={onOpenThread}
              onOpenThreadReply={onOpenThreadReply}
              onLike={onLike}
              onReply={onReply}
              onWhisper={onWhisper}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
              onPreview={onPreview}
            />
            {/* Interleaved comments = replies to this card, rendered right after
             * it so the position (between which cards) is preserved.
             * When 5+ replies, older middle ones are collapsed with a smooth
             * expand/collapse animation; the latest 3 stay visible at bottom. */}
            <CollapsibleReplies
              replies={post.replies ?? []}
              auth={auth}
              avatarSrc={avatarSrc}
              mentionMembers={mentionMembers}
              searchQuery={searchQuery}
              onOpenThread={onOpenThread}
              onOpenThreadReply={onOpenThreadReply}
              onLike={onLike}
              onReply={onReply}
              onWhisper={onWhisper}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
              onPreview={onPreview}
            />
            {/* "+" insert control: a small circular button centered in a slim row
             * between cards. Center placement is intuitive ("insert here"),
             * while the single narrow row keeps vertical space tight. */}
            {inlineReplyFor === post.id ? (
              <Stack
                gap={6}
                p="xs"
                style={{ background: "var(--bg-subtle)", borderRadius: 8, border: "1px solid var(--border-green-soft)" }}
              >
                <Text size="xs" c="dimmed">
                  この位置にコメントします
                </Text>
                <MentionTextarea
                  value={inlineReplyText}
                  autoFocus
                  onChange={onInlineReplyChange}
                  placeholder={`${g.authorName || g.authorEmail.split("@")[0]} の投稿にコメント…（Shift+Enter でささやく）`}
                  minRows={2}
                  autosize
                  maxRows={5}
                  onKeyDown={(e) => {
                    if ((e.nativeEvent as any).isComposing) return;
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      onInlineReplySubmit(post.id, false);
                    } else if (e.shiftKey && e.key === "Enter") {
                      e.preventDefault();
                      onInlineReplySubmit(post.id, true);
                    }
                  }}
                />
                {/* Comment image attachments (same as main post) */}
                {inlineReplyImages.length > 0 && (
                  <Group gap="xs" mb={4}>
                    {inlineReplyImages.map((src, i) => (
                      <Box key={i} style={{ position: "relative" }}>
                        <Image
                          src={src}
                          width={56}
                          height={56}
                          fit="contain"
                          radius="md"
                          style={{ cursor: "pointer" }}
                          onClick={() => onPreview(src)}
                        />
                        <ActionIcon
                          size="sm"
                          variant="filled"
                          color="red"
                          radius="xl"
                          style={{ position: "absolute", top: -6, right: -6 }}
                          onClick={() => onRemoveInlineReplyImage(i)}
                        >
                          ×
                        </ActionIcon>
                      </Box>
                    ))}
                  </Group>
                )}
                <Group gap="xs" mb={4}>
                  <label style={{ cursor: "pointer", display: "inline-block" }}>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      hidden
                      onChange={(e) => {
                        onInlineReplyPick(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <Button
                      size="xs"
                      variant="light"
                      color="gray"
                      component="span"
                      loading={inlineUploading}
                      disabled={inlineReplyImages.length >= 5}
                    >
                      📷 {inlineReplyImages.length}/5
                    </Button>
                  </label>
                </Group>
                <Group justify="space-between" align="center" gap="xs">
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => onToggleInlineReply(post.id)}
                  >
                    キャンセル
                  </Button>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      color="blue"
                      variant="light"
                      loading={inlineReplying === 'whisper'}
                      disabled={(!inlineReplyText.trim() && inlineReplyImages.length === 0) || inlineReplying !== false}
                      onClick={() => onInlineReplySubmit(post.id, true)}
                    >
                      ささやく
                    </Button>
                    <Button
                      size="xs"
                      loading={inlineReplying === 'comment'}
                      disabled={(!inlineReplyText.trim() && inlineReplyImages.length === 0) || inlineReplying !== false}
                      onClick={() => onInlineReplySubmit(post.id, false)}
                    >
                      コメント
                    </Button>
                  </Group>
                </Group>
              </Stack>
            ) : (
              <Box style={{ display: "flex", justifyContent: "center", lineHeight: 0 }}>
                <UnstyledButton
                  onClick={() => onToggleInlineReply(post.id)}
                  aria-label="コメントを挟み込む"
                  style={{ cursor: "pointer", padding: 2, background: "transparent", border: "none", lineHeight: 1 }}
                >
                  <Box
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: "1px solid var(--border-green)",
                      color: "var(--text-green-soft)",
                      background: "var(--bg-surface)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
                    }}
                  >
                    ＋
                  </Box>
                </UnstyledButton>
              </Box>
            )}
          </Fragment>
        ))}
      </Box>
    );
  }

  if (rendered.length === 0) {
    return (
      <Paper p="xl" radius="md" withBorder>
        <Text ta="center" c="dimmed">
          まだ投稿がありません
        </Text>
      </Paper>
    );
  }
  return <>{rendered}</>;
}

/**
 * Optimistically insert a newly created reply (or whisper) under its parent
 * WITHOUT refetching the whole feed — so the card's scroll position, the
 * loaded "older" pages, and the group layout are all preserved.
 *
 * - whisper: the group stays put; only the new reply is appended inside it.
 * - comment: the group is bumped to the top of the timeline (existing behavior)
 *   and stays there, keeping its loaded content.
 */
function appendReplyLocal(
  feed: FeedPost[],
  parentId: number,
  created: FeedPost,
  whisper: boolean
): FeedPost[] {
  const now = created.createdAt || new Date().toISOString();
  const reply: FeedPost = {
    id: created.id,
    authorEmail: created.authorEmail,
    authorName: created.authorName ?? null,
    authorAvatar: created.authorAvatar ?? null,
    parentId,
    text: created.text ?? "",
    images: created.images ?? [],
    urlPreview: created.urlPreview ?? null,
    likeCount: created.likeCount ?? 0,
    likedByMe: created.likedByMe ?? false,
    createdAt: now,
    lastActivityAt: now,
    replies: [],
    replyCount: 0,
  };

  const appendTo = (root: FeedPost): FeedPost => {
    const list = [...(root.replies ?? [])];
    if (!list.some((rp) => rp.id === reply.id)) {
      list.push(reply);
      list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }
    const bumped = {
      ...root,
      replies: list,
      replyCount: (root.replyCount ?? 0) + 1,
      // Normal comments move the group up (its lastActivity follows the new
      // reply); whispers deliberately leave lastActivity unchanged.
      lastActivityAt: whisper ? root.lastActivityAt : now,
    };
    return bumped;
  };

  let changed = false;
  const next = feed.map((root) => {
    if (root.id === parentId) {
      changed = true;
      return appendTo(root);
    }
    if ((root.replies ?? []).some((rp) => rp.id === parentId)) {
      changed = true;
      return appendTo(root);
    }
    return root;
  });

  if (!changed) return feed;

  if (whisper) return next;

  // For a normal comment, bring the bumped group to the top.
  const bumped = next.find((r) => r.id === parentId || (r.replies ?? []).some((rp) => rp.id === parentId));
  if (!bumped) return next;
  return [
    bumped,
    ...next.filter((r) => r !== bumped),
  ];
}

export default function Home() {
  const [auth, setAuth] = useState<null | {
    email: string;
    name?: string | null;
    avatar?: string | null;
  }>(null);
  const [checking, setChecking] = useState(true);

  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // ---- Dark mode toggle ----
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";

  const [activeNav, setActiveNav] = useState("feed");
  const [navOpened, setNavOpened] = useState(false);
  const [asideOpened, setAsideOpened] = useState(false);

  // ---- Timeline search ----
  const [searchQuery, setSearchQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const searchQueryRef = useRef("");
  searchQueryRef.current = searchQuery;

  // ---- Admin-managed external-link menu (sidebar bookmarks) ----
  const [menuLinks, setMenuLinks] = useState<MenuLinkItem[]>([]);
  const [linkModal, setLinkModal] = useState<{
    open: boolean;
    editingId: number | null;
    label: string;
    icon: string;
    href: string;
  }>({ open: false, editingId: null, label: "", icon: "🔗", href: "" });
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [linkSaving, setLinkSaving] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const isAdminAuth = !!auth && ADMIN_EMAILS.has(auth.email);
  const loadMenuLinks = useCallback(() => {
    fetch("/api/menu-links")
      .then((r) => r.json())
      .then((d) => {
        if (d && Array.isArray(d.links)) setMenuLinks(d.links);
      })
      .catch(() => {});
  }, []);
  const openAddLink = () =>
    setLinkModal({ open: true, editingId: null, label: "", icon: "🔗", href: "" });
  const openEditLink = (lk: MenuLinkItem) =>
    setLinkModal({
      open: true,
      editingId: lk.id,
      label: lk.label,
      icon: lk.icon,
      href: lk.href,
    });
  const saveLink = async () => {
    setLinkSaving(true);
    setLinkError(null);
    try {
      if (!linkModal.label.trim() || !linkModal.href.trim()) {
        setLinkError("ラベルとURLは必須です");
        return;
      }
      const path = linkModal.editingId
        ? `/api/menu-links/${linkModal.editingId}`
        : "/api/menu-links";
      const method = linkModal.editingId ? "PATCH" : "POST";
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: linkModal.label,
          icon: linkModal.icon,
          href: linkModal.href,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || "保存に失敗しました");
      await loadMenuLinks();
      setLinkModal((m) => ({ ...m, open: false }));
    } catch (e: any) {
      setLinkError(e.message || "保存に失敗しました");
    } finally {
      setLinkSaving(false);
    }
  };
  const removeLink = async (id: number) => {
    const res = await fetch(`/api/menu-links/${id}`, { method: "DELETE" });
    const d = await res.json();
    if (!res.ok) {
      setLinkError(d.error || "削除に失敗しました");
      return;
    }
    setConfirmDeleteId(null);
    await loadMenuLinks();
  };

  // ---- Feed state ----
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const [feedHasMore, setFeedHasMore] = useState(true);
  // Active pins, shown in the right sidebar summary panel (FIFO order).
  const [pinnedPosts, setPinnedPosts] = useState<FeedPost[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  // Hot topics: top active root posts in the last 7 days (right sidebar).
  const [hotPosts, setHotPosts] = useState<FeedPost[]>([]);
  const [hotLoading, setHotLoading] = useState(false);
  // Post currently being jumped-to from a right-sidebar card (feeds the card's
  // loading indicator while it pages back to fetch the post).
  const [scrollingPostId, setScrollingPostId] = useState<number | null>(null);
  // After posting a comment/whisper, we scroll to the (potentially bumped)
  // parent post so the user sees their contribution in context. Set via ref,
  // consumed by a useEffect that watches feedPosts and performs the scroll.
  const pendingScrollRef = useRef<number | null>(null);
  const feedCursorRef = useRef<string | null>(null);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  const [postText, setPostText] = useState("");
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);

  // ---- Dori News state ----
  const [dnArticles, setDnArticles] = useState<DrinewsArticle[]>([]);
  const [dnLoading, setDnLoading] = useState(false);
  const [dnIsDrikin, setDnIsDrikin] = useState(false);
  const [dnSelected, setDnSelected] = useState<DrinewsArticle | null>(null);
  const [dnComments, setDnComments] = useState<DrinewsComment[]>([]);
  const [dnEditing, setDnEditing] = useState<DrinewsArticle | null>(null); // article being authored
  const [dnEditorTitle, setDnEditorTitle] = useState("");
  const [dnEditorMd, setDnEditorMd] = useState("");
  const [dnSaving, setDnSaving] = useState(false);
  const [dnCommentText, setDnCommentText] = useState("");
  const [dnPostingComment, setDnPostingComment] = useState(false);
  const [dnError, setDnError] = useState<string | null>(null);
  const [dnProofreading, setDnProofreading] = useState(false);
  const [dnEditorHeaderImage, setDnEditorHeaderImage] = useState<string | null>(null);
  const [dnUploadingHeader, setDnUploadingHeader] = useState(false);

  // ---- Feed edit/delete state ----
  const [postError, setPostError] = useState<string | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [editingPost, setEditingPost] = useState<FeedPost | null>(null);
  const [editText, setEditText] = useState("");
  const [editImages, setEditImages] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<FeedPost | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- Reply / thread state ----
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState<'comment' | 'whisper' | false>(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [threadPost, setThreadPost] = useState<FeedPost | null>(null);
  const [threadReplies, setThreadReplies] = useState<FeedPost[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadReplyBoxOpen, setThreadReplyBoxOpen] = useState(false);
  // Whisper mode for the thread reply box (is_whisper => no timeline bump).
  const [threadWhisper, setThreadWhisper] = useState(false);
  // Inline "insert between cards" reply state (timeline group comments).
  const [inlineReplyFor, setInlineReplyFor] = useState<number | null>(null);
  const [inlineReplyText, setInlineReplyText] = useState("");
  const [inlineReplying, setInlineReplying] = useState<'comment' | 'whisper' | false>(false);
  // Whisper mode for the inline box: posts the reply as a whisper (is_whisper),
  // which does NOT bump the group to the top of the timeline.
  const [inlineWhisper, setInlineWhisper] = useState(false);

  // Image attachments for replies (thread + inline), kept separate from the
  // main-post images so each box manages its own uploads.
  const [threadReplyImages, setThreadReplyImages] = useState<string[]>([]);
  const [threadUploading, setThreadUploading] = useState(false);
  const [inlineReplyImages, setInlineReplyImages] = useState<string[]>([]);
  const [inlineUploading, setInlineUploading] = useState(false);

  // ---- Mobile keyboard detection ----
  // When the virtual keyboard opens on mobile, visualViewport shrinks.
  // We switch modals from centered to top-aligned so the input stays visible.
  const [kbOpen, setKbOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => {
      // Keyboard is shown when the visual viewport is meaningfully shorter
      // than the layout viewport.
      const delta = window.innerHeight - vv.height;
      setKbOpen(delta > 120);
    };
    check();
    vv.addEventListener("resize", check);
    window.addEventListener("resize", check);
    return () => {
      vv.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const editFileRef = useRef<HTMLInputElement>(null);

  // ---- Notifications state ----
  const [notifications, setNotifications] = useState<any[]>([]);
  const [notifUnread, setNotifUnread] = useState(0);

  const displayName = auth?.name || auth?.email?.split("@")[0] || "";
  // @mention members list (for highlight in post display)
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
  useEffect(() => {
    if (!auth) return;
    fetch("/api/members")
      .then(r => r.json())
      .then(d => { if (d.members) setMentionMembers(d.members); })
      .catch(() => {});
  }, [auth]);
  const avatarSrc = auth?.avatar || undefined;

  const checkAuth = useCallback(() => {
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((d) => {
        if (d.authenticated)
          setAuth({ email: d.email, name: d.name, avatar: d.avatar });
      })
      .finally(() => setChecking(false));
  }, []);

  useEffect(() => {
    checkAuth();
    // Support browser back button: when the #/post hash is removed (via the
    // back button or history.back()), close the thread view.
    const onPop = () => {
      if (!(window.location.hash || "").startsWith("#/post/")) {
        setThreadPost(null);
        setThreadReplies([]);
        setThreadReplyBoxOpen(false);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [checkAuth]);

  useEffect(() => {
    if (!auth) {
      setFeedLoading(false);
      return;
    }
    loadFeed();
    loadPinned();
    loadHot();
    loadNotifications();
    loadMenuLinks();
    // Deep-link from the drinews email CTA: /?drinews=<id>
    const params = new URLSearchParams(window.location.search);
    const deepId = Number(params.get("drinews"));
    if (deepId && deepId > 0) {
      const t = window.setTimeout(() => {
        setActiveNav("drinews");
        openDrinews(deepId);
      }, 300);
      return () => window.clearTimeout(t);
    }
    // Deep-link from a post permalink: #/post/<id>
    // openThread pushes #/post/<id> so the URL can be shared/bookmarked,
    // but on a fresh page load nothing restores the thread view. Re-open it.
    const postHash = window.location.hash || "";
    if (postHash.startsWith("#/post/")) {
      const pid = Number(postHash.slice("#/post/".length));
      if (pid && pid > 0) {
        const t = window.setTimeout(() => openThread(pid), 300);
        return () => window.clearTimeout(t);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  // Fetch the currently active pins (within 24h, oldest-pinned first) for the
  // right-sidebar summary panel. Refreshed on login, on SSE "pin" events and
  // after a pin toggle.
  const loadPinned = useCallback(() => {
    if (!auth) {
      setPinnedPosts([]);
      return;
    }
    setPinnedLoading(true);
    fetch("/api/posts?pinned=1")
      .then((r) => r.json())
      .then((d) => setPinnedPosts(d.posts ?? []))
      .catch(() => setPinnedPosts([]))
      .finally(() => setPinnedLoading(false));
  }, [auth]);

  // Fetch the top hot topics (most-commented root posts in the last 7 days) for
  // the right-sidebar panel. Refreshed on login, on SSE "post" events (a new
  // comment bumps the ranking), after a pin toggle does nothing here).
  const loadHot = useCallback(() => {
    if (!auth) {
      setHotPosts([]);
      return;
    }
    setHotLoading(true);
    fetch("/api/posts?hot=1&limit=5")
      .then((r) => r.json())
      .then((d) => setHotPosts(d.posts ?? []))
      .catch(() => setHotPosts([]))
      .finally(() => setHotLoading(false));
  }, [auth]);

  const [onlineMembers, setOnlineMembers] = useState<
    { email: string; name: string | null; avatar?: string | null }[]
  >([]);
  const loadOnline = useCallback(() => {
    if (!auth) {
      setOnlineMembers([]);
      return;
    }
    fetch("/api/presence")
      .then((r) => r.json())
      .then((d) => setOnlineMembers(d.members ?? []))
      .catch(() => setOnlineMembers([]));
  }, [auth]);

  // Real-time "wave" (👋 flying up from bottom-right, Insta-live style).
  // waves: { id, fromName, kind } — kind "received" = someone waved at me
  // (show their name), "sent" = I waved at someone (just a hand, feedback).
  const [waves, setWaves] = useState<
    { id: number; fromName: string; kind: "sent" | "received" }[]
  >([]);
  const waveIdRef = useRef(0);
  // Stable callbacks: showWave/sendWave only touch functional setState + a ref,
  // so they can be safely listed in the SSE effect deps without recreating the
  // EventSource on every render (see the SSE "Effect dependency" pitfall).
  const showWave = useCallback((fromName: string, kind: "sent" | "received") => {
    const id = ++waveIdRef.current;
    setWaves((w) => [...w, { id, fromName, kind }]);
    window.setTimeout(() => setWaves((w) => w.filter((x) => x.id !== id)), 3000);
  }, []);
  const sendWave = useCallback((toEmail: string, toName: string) => {
    if (!auth || toEmail === auth.email) return;
    fetch("/api/wave", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: toEmail }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) showWave(toName, "sent"); // instant sender feedback
      })
      .catch(() => {});
  }, [auth, showWave]);

  const FEED_PAGE = 50;

  const loadFeed = (filter?: string, search?: string) => {
    setFeedLoading(true);
    setFeedHasMore(true);
    feedCursorRef.current = null;
    const s = search?.trim();
    const q = `?limit=${FEED_PAGE}${filter ? `&filter=${filter}` : ""}${s ? `&search=${encodeURIComponent(s)}` : ""}`;
    fetch(`/api/posts${q}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const posts = d.posts ?? [];
        setFeedPosts(posts);
        if (posts.length > 0) {
          feedCursorRef.current =
            posts[posts.length - 1].lastActivityAt ??
            posts[posts.length - 1].createdAt;
        }
        setFeedHasMore(posts.length === FEED_PAGE);
      })
      .catch(() => {
        setFeedPosts([]);
        setFeedHasMore(false);
      })
      .finally(() => setFeedLoading(false));
  };

  // Load the next, older page of the feed and append it (infinite scroll).
  const loadMoreFeed = () => {
    if (!feedHasMore || feedLoadingMore || feedLoading || !feedCursorRef.current)
      return;
    setFeedLoadingMore(true);
    const filter = activeNav === "gallery" ? "images" : activeNav === "news" ? "links" : activeNav === "episodes" ? "episodes" : undefined;
    const s = searchQueryRef.current.trim();
    const q = `?limit=${FEED_PAGE}&before=${encodeURIComponent(feedCursorRef.current)}${
      filter ? `&filter=${filter}` : ""
    }${s ? `&search=${encodeURIComponent(s)}` : ""}`;
    fetch(`/api/posts${q}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        const posts = d.posts ?? [];
        setFeedPosts((prev) => [
          ...prev,
          ...posts.filter((np: FeedPost) => !prev.some((p) => p.id === np.id)),
        ]);
        if (posts.length > 0) {
          feedCursorRef.current =
            posts[posts.length - 1].lastActivityAt ??
            posts[posts.length - 1].createdAt;
        }
        setFeedHasMore(posts.length === FEED_PAGE);
      })
      .catch(() => setFeedHasMore(false))
      .finally(() => setFeedLoadingMore(false));
  };

  // ---- Push (SSE) live refresh ----
  // The EventSource stays open for as long as the page lives; we read the
  // *current* view/filter state through refs so an incoming event never causes
  // a tear-down / reconnect. (Teardown/reconnect was dropping events.)
  const activeNavRef = useRef(activeNav);
  activeNavRef.current = activeNav;
  const threadPostRef = useRef(threadPost);
  threadPostRef.current = threadPost;
  const feedLoadingRef = useRef(feedLoading);
  feedLoadingRef.current = feedLoading;

  // Debounce + abort controller for silentRefreshFeed: multiple SSE events
  // arriving in quick succession (e.g. rapid comments) used to fire several
  // concurrent fetches whose setState callbacks raced and caused duplicates
  // or stale overwrites. We keep only the latest request and discard earlier
  // in-flight ones.
  const silentRefreshAbortRef = useRef<AbortController | null>(null);
  const silentRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const silentRefreshFeed = useCallback(() => {
    // Don't refresh during search — SSE events would wipe the search results.
    if (searchQueryRef.current.trim()) return;
    const nav = activeNavRef.current;
    // NOTE: we intentionally do NOT skip when feedLoadingRef.current is true.
    // The merge logic (below) safely diffs server data against local state,
    // so even a concurrent loadFeed() won't cause stale overwrites. Skipping
    // here was causing SSE events to be silently dropped when a loadFeed was
    // in flight (e.g. right after goHome / nav switch), which was the root
    // cause of "comments not reflecting until manual reload".

    // Debounce: collapse rapid successive events into a single fetch (150ms).
    if (silentRefreshTimerRef.current) clearTimeout(silentRefreshTimerRef.current);
    silentRefreshTimerRef.current = setTimeout(() => {
      // Abort any previous in-flight refresh to avoid a stale response
      // overwriting a newer one.
      if (silentRefreshAbortRef.current) silentRefreshAbortRef.current.abort();
      const ac = new AbortController();
      silentRefreshAbortRef.current = ac;

      const filter = nav === "gallery" ? "images" : nav === "news" ? "links" : nav === "episodes" ? "episodes" : undefined;
      const q = `?limit=${FEED_PAGE}${filter ? `&filter=${filter}` : ""}`;
      fetch(`/api/posts${q}`, { signal: ac.signal, cache: "no-store" })
        .then((r) => r.json())
        .then((d) => {
          const fresh = d.posts ?? [];
          setFeedPosts((prev) => {
            if (fresh.length === 0 && prev.length === 0) return prev;
            const freshIds = new Set(fresh.map((p: FeedPost) => p.id));
            // Build the merged result:
            // - For posts in `fresh`: use the server version (authoritative for
            //   sort order, reply count, likes, URL previews) BUT preserve any
            //   optimistic replies (tempId or just-created real replies) that
            //   the server hasn't seen yet.
            // - For posts NOT in fresh: keep them as-is (older pages / temp posts).
            const prevMap = new Map(prev.map((p) => [p.id, p]));
            const merged = fresh.map((fp: FeedPost) => {
              const oldP = prevMap.get(fp.id);
              if (!oldP) return fp;
              // Preserve optimistic replies that the server doesn't have yet.
              const serverReplyIds = new Set((fp.replies ?? []).map((r) => r.id));
              const oldReplies = oldP.replies ?? [];
              const preservedReplies = oldReplies.filter(
                (rp) => !serverReplyIds.has(rp.id) && rp.id > 0
              );
              if (preservedReplies.length > 0) {
                return { ...fp, replies: [...(fp.replies ?? []), ...preservedReplies] };
              }
              return fp;
            });
            const older = prev.filter(
              (p) => !freshIds.has(p.id) && p.id > 0
            );
            return [...merged, ...older];
          });
          if (fresh.length > 0) {
            feedCursorRef.current =
              fresh[fresh.length - 1].lastActivityAt ?? fresh[fresh.length - 1].createdAt;
          }
          setFeedHasMore(fresh.length >= FEED_PAGE);
        })
        .catch(() => {});
    }, 150);
  }, []);

  // Open exactly ONE stream for the lifetime of the page (while logged in). The
  // handler ignores events while a thread is open or during an initial load;
  // the client filter is read from refs so an incoming event never tears us down.
  useEffect(() => {
    if (!auth) return;
    const es = new EventSource("/api/posts/stream");
    const onChange = (e: MessageEvent) => {
      // Skip events triggered by our own posts — we already did an optimistic
      // update, and a silentRefreshFeed here would race with the POST response
      // handler, causing duplicates / missing replies.
      let authorEmail: string | undefined;
      try {
        const d = JSON.parse(e.data);
        authorEmail = d?.authorEmail;
      } catch {}
      if (auth && authorEmail && authorEmail === auth.email) {
        // Still refresh hot topics (other people's view of activity changed)
        loadHot();
        return;
      }
      loadHot(); // new post/comment may change the hot-topics ranking
      if (threadPostRef.current) return;
      silentRefreshFeed();
    };
    const onPinChange = () => {
      loadPinned(); // refresh the right-sidebar pin summary panel
      if (!threadPostRef.current) silentRefreshFeed();
    };
    const onPresenceChange = () => {
      loadOnline(); // refresh the right-sidebar online panel
    };
    const onWave = (e: MessageEvent) => {
      let d: any;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!d || d.type !== "wave" || !auth) return;
      if (d.to === auth.email) {
        showWave(d.from?.name || d.from?.email || "", "received");
      } else if (d.from?.email === auth.email) {
        showWave(d.from?.name || "", "sent");
      }
    };
    es.addEventListener("post", onChange);
    es.addEventListener("pin", onPinChange);
    es.addEventListener("presence", onPresenceChange);
    es.addEventListener("wave", onWave);
    es.onopen = () => {
      loadPinned();
      loadHot();
      loadOnline();
      if (!threadPostRef.current) silentRefreshFeed();
    };
    es.onerror = () => {
      // EventSource auto-reconnects. When it does, onopen fires and we
      // silentRefreshFeed() to recover any events missed during the
      // disconnect. Nothing to do here — the reconnect + onopen handles it.
    };
    return () => {
      es.close();
    };
  }, [auth, silentRefreshFeed, loadPinned, loadHot, loadOnline, showWave]);

  // Scroll to a post after its reply bumps it (or after inline insertion).
  // pendingScrollRef is set by submitInlineReply / submitThreadReply on
  // success. We wait for the next feedPosts commit (which reflects the
  // optimistic / server update), then scrollIntoView the [data-post-id]
  // element. A double-rAF ensures React has painted the DOM.
  useEffect(() => {
    const targetId = pendingScrollRef.current;
    if (targetId == null) return;
    const el = document.querySelector(
      `[data-post-id="${targetId}"]`
    ) as HTMLElement | null;
    if (!el) return; // not rendered (e.g. filtered view) — give up silently
    pendingScrollRef.current = null;
    // Double rAF: wait for the browser to paint the updated layout.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("pin-target-flash");
        window.setTimeout(() => el.classList.remove("pin-target-flash"), 2400);
      })
    );
  }, [feedPosts]);

  // Periodic self-heal for the online panel: refresh even if a presence SSE
  // event or onopen callback was missed (e.g. iOS Safari dropping the stream).
  useEffect(() => {
    if (!auth) return;
    loadOnline();
    const t = window.setInterval(loadOnline, 60000);
    return () => window.clearInterval(t);
  }, [auth, loadOnline]);

  const loadNotifications = useCallback(() => {
    if (!auth) return;
    fetch("/api/notifications")
      .then((r) => r.json())
      .then((d) => {
        setNotifications(d.notifications ?? []);
        setNotifUnread(d.unreadCount ?? 0);
      })
      .catch(() => {});
  }, [auth]);

  // Resolve the topmost (root) post id of a given post, so a notification
  // (which may point at a reply) jumps to the group that is actually rendered
  // on the main timeline. The timeline only shows root groups; commenting
  // there is a normal top-level reply everyone can see, instead of the hidden
  // "grandchild" that opening the reply's thread view used to create.
  const resolveRootId = async (id: number): Promise<number> => {
    let cur = id;
    const seen = new Set<number>();
    while (!seen.has(cur)) {
      seen.add(cur);
      try {
        const d = await fetch(`/api/posts/${cur}`, { cache: "no-store" }).then(
          (r) => r.json()
        );
        const p = d?.post;
        if (!p || p.parentId == null) break; // not found, or this is the root
        cur = p.parentId;
      } catch {
        break;
      }
    }
    return cur;
  };

  const handleNotifClick = async (n: any) => {
    setActiveNav("feed"); // ensure the feed view can render & scroll
    if (!n.readAt) {
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      });
      loadNotifications();
    }
    const targetId = n.replyId ?? n.postId;
    if (targetId) {
      // Link to the card on the MAIN timeline (not the reply's thread view),
      // so a follow-up comment is a normal top-level reply that stays visible.
      const rootId = await resolveRootId(targetId);
      scrollToPinnedPost(rootId);
    }
  };

  // Mark all read
  const markAllNotifRead = () => {
    fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    }).then(() => loadNotifications());
  };

  // Clear all notifications (delete)
  const clearAllNotif = () => {
    fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    }).then(() => loadNotifications());
  };

  // ---- Dori News handlers ----
  const loadDrinews = useCallback(() => {
    if (!auth) return;
    setDnLoading(true);
    fetch("/api/drinews?all=1")
      .then((r) => r.json())
      .then((d) => {
        setDnArticles(d.articles ?? []);
        setDnIsDrikin(!!d.isDrikin);
      })
      .catch(() => setDnArticles([]))
      .finally(() => setDnLoading(false));
  }, [auth]);

  const openDrinews = useCallback((id: number) => {
    setDnSelected(null);
    setDnComments([]);
    fetch(`/api/drinews/${id}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.article) setDnSelected(d.article);
        setDnComments(d.comments ?? []);
      })
      .catch(() => setDnSelected(null));
  }, []);

  const dnCloseView = useCallback(() => {
    setDnSelected(null);
    setDnEditing(null);
  }, []);

  const dnStartNew = useCallback(() => {
    setDnError(null);
    setDnEditing(null);
    setDnEditorTitle(drinewsNextTitle());
    setDnEditorMd("");
    setDnEditorHeaderImage(null);
    setDnSelected(null);
    // Enter authoring mode: a pseudo-article with no id marks "new draft".
    setDnEditing({ id: 0 } as DrinewsArticle);
  }, []);

  const dnStartEdit = useCallback((a: DrinewsArticle) => {
    setDnError(null);
    setDnSelected(null);
    setDnEditorTitle(a.title);
    setDnEditorMd(a.bodyMd);
    setDnEditorHeaderImage(a.headerImage ?? null);
    setDnEditing(a);
  }, []);

  const dnCloseEditor = useCallback(() => {
    setDnEditing(null);
    setDnEditorTitle("");
    setDnEditorMd("");
    setDnEditorHeaderImage(null);
    setDnError(null);
    loadDrinews();
  }, [loadDrinews]);

  // Save draft: POST for new, PATCH for existing. bodyHtml regenerated server-side.
  const dnSaveDraft = useCallback(async () => {
    if (!dnEditorTitle.trim() && !dnEditorMd.trim()) {
      setDnError("タイトルまたは本文を入力してください");
      return;
    }
    setDnSaving(true);
    setDnError(null);
    const isNew = !dnEditing?.id;
    const url = isNew ? "/api/drinews" : `/api/drinews/${dnEditing!.id}`;
    try {
      const r = await fetch(url, {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: dnEditorTitle, bodyMd: dnEditorMd, bodyHtml: dnEditorMd, headerImage: dnEditorHeaderImage }),
      });
      const d = await r.json();
      if (!r.ok) {
        setDnError(d.error || "保存に失敗しました");
        return;
      }
      setDnEditing(d.article);
      loadDrinews();
    } catch {
      setDnError("保存に失敗しました");
    } finally {
      setDnSaving(false);
    }
  }, [dnEditing, dnEditorTitle, dnEditorMd, dnEditorHeaderImage, loadDrinews]);

  // Upload header image: resize client-side (max 2048px) then POST to /api/drinews/upload
  const dnUploadHeaderImage = useCallback(async (file: File) => {
    setDnUploadingHeader(true);
    setDnError(null);
    try {
      // Resize via Canvas (reuse resizeImage with maxW=2048)
      const resized = await resizeImage(file, 2048, 0.85);
      const fd = new FormData();
      fd.append("image", resized, file.name);
      const r = await fetch("/api/drinews/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) {
        setDnError(d.error || "画像のアップロードに失敗しました");
        return;
      }
      setDnEditorHeaderImage(d.url);
    } catch {
      setDnError("画像のアップロードに失敗しました");
    } finally {
      setDnUploadingHeader(false);
    }
  }, []);

  // AI proofread / restructure the draft via OpenRouter (drikin only).
  const dnProofread = useCallback(async () => {
    if (dnProofreading) return;
    if (!dnEditorMd.trim()) {
      setDnError("本文を入力してからAI校正を実行してください");
      return;
    }
    setDnProofreading(true);
    setDnError(null);
    try {
      const r = await fetch("/api/drinews/proofread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: dnEditorTitle, bodyMd: dnEditorMd }),
      });
      const d = await r.json();
      if (!r.ok) {
        setDnError(d.error || "AI校正に失敗しました");
        return;
      }
      if (d.title && dnEditorTitle === drinewsNextTitle()) {
        // Only adopt AI title when the current one is still the auto date title.
        setDnEditorTitle(d.title);
      }
      setDnEditorMd(d.markdown ?? d.raw ?? "");
    } catch {
      setDnError("AI校正に失敗しました");
    } finally {
      setDnProofreading(false);
    }
  }, [dnProofreading, dnEditorMd, dnEditorTitle]);

  const dnPublish = useCallback(
    async (id: number) => {
      if (!window.confirm("この記事を公開しますか？")) return;
      setDnError(null);
      try {
        const r = await fetch(`/api/drinews/${id}/publish`, { method: "POST" });
        const d = await r.json();
        if (!r.ok) {
          setDnError(d.error || "公開に失敗しました");
          return;
        }
        setDnEditing(null);
        loadDrinews();
        openDrinews(id);
      } catch {
        setDnError("公開に失敗しました");
      }
    },
    [loadDrinews, openDrinews]
  );

  // Schedule publish for the next JST 18:00.
  const dnSchedule18 = useCallback(
    async (id: number) => {
      setDnError(null);
      const { y, mo, d } = nextJst18Date();
      const scheduledAt = new Date(Date.UTC(y, mo - 1, d, 9)).toISOString(); // 18:00 JST = 09:00 UTC
      try {
        const r = await fetch(`/api/drinews/${id}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scheduledAt }),
        });
        const dJson = await r.json();
        if (!r.ok) {
          setDnError(dJson.error || "予約設定に失敗しました");
          return;
        }
        setDnEditing(dJson.article);
        setDnError("18:00 JST に公開予約しました");
      } catch {
        setDnError("予約設定に失敗しました");
      }
    },
    []
  );

  const dnSendEmail = useCallback(
    async (id: number) => {
      if (!window.confirm("会員全員にメール配信しますか？")) return;
      setDnError(null);
      try {
        const r = await fetch(`/api/drinews/${id}/send`, { method: "POST" });
        const d = await r.json();
        if (!r.ok) {
          setDnError(d.error || "配信に失敗しました");
        } else {
          setDnError(`${d.sent ?? 0} 名に配信しました${d.skipped ? `（失敗 ${d.skipped}）` : ""}`);
        }
      } catch {
        setDnError("配信に失敗しました");
      }
    },
    []
  );

  // Revert a published article back to draft (drikin only).
  const dnUnpublish = useCallback(
    async (id: number) => {
      if (!window.confirm("この記事を下書きに戻しますか？（公開取り消し）")) return;
      setDnError(null);
      try {
        const r = await fetch(`/api/drinews/${id}/unpublish`, { method: "POST" });
        const d = await r.json();
        if (!r.ok) {
          setDnError(d.error || "下書きへの変更に失敗しました");
          return;
        }
        setDnSelected(d.article);
        loadDrinews();
      } catch {
        setDnError("下書きへの変更に失敗しました");
      }
    },
    [loadDrinews]
  );

  // Delete an article (drikin only). Comments cascade-delete.
  const dnDeleteArticle = useCallback(
    async (id: number) => {
      if (!window.confirm("この記事を完全に削除しますか？コメントも削除されます。")) return;
      setDnError(null);
      try {
        const r = await fetch(`/api/drinews/${id}`, { method: "DELETE" });
        const d = await r.json();
        if (!r.ok) {
          setDnError(d.error || "削除に失敗しました");
          return;
        }
        setDnSelected(null);
        loadDrinews();
      } catch {
        setDnError("削除に失敗しました");
      }
    },
    [loadDrinews]
  );

  const dnSubmitComment = useCallback(async () => {
    if (!dnSelected || !dnCommentText.trim()) return;
    setDnPostingComment(true);
    try {
      const r = await fetch(`/api/drinews/${dnSelected.id}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: dnCommentText, name: auth?.name ?? null }),
      });
      const d = await r.json();
      if (!r.ok) {
        setDnError(d.error || "コメント投稿に失敗しました");
        return;
      }
      setDnComments((prev) => [...prev, d.comment]);
      setDnCommentText("");
      setDnSelected((prev) =>
        prev ? { ...prev, commentCount: prev.commentCount + 1 } : prev
      );
    } catch {
      setDnError("コメント投稿に失敗しました");
    } finally {
      setDnPostingComment(false);
    }
  }, [dnSelected, dnCommentText, auth]);

  const dnDeleteComment = useCallback(
    async (commentId: number) => {
      if (!window.confirm("このコメントを削除しますか？")) return;
      try {
        const r = await fetch(`/api/drinews/comments/${commentId}`, { method: "DELETE" });
        const d = await r.json();
        if (!r.ok) {
          setDnError(d.error || "削除に失敗しました");
          return;
        }
        setDnComments((prev) => prev.filter((c) => c.id !== commentId));
        setDnSelected((prev) =>
          prev ? { ...prev, commentCount: Math.max(0, prev.commentCount - 1) } : prev
        );
      } catch {
        setDnError("削除に失敗しました");
      }
    },
    []
  );

  // Load filtered feed when switching views
  useEffect(() => {
    if (!auth) return;
    if (activeNav === "gallery") loadFeed("images");
    else if (activeNav === "news") loadFeed("links");
    else if (activeNav === "episodes") loadFeed("episodes");
    else if (activeNav === "drinews") loadDrinews();
    else if (activeNav === "feed") loadFeed();
  }, [activeNav, auth]);

  // Debounced search: when searchQuery changes, wait 300ms then reload feed
  // with the search parameter. Switching to feed view if needed.
  useEffect(() => {
    if (!auth) return;
    const trimmed = searchQuery.trim();
    if (trimmed) {
      setSearchActive(true);
      if (activeNav !== "feed") setActiveNav("feed");
    } else {
      setSearchActive(false);
    }
    const t = setTimeout(() => {
      if (!auth) return;
      const q = searchQueryRef.current.trim();
      if (q) {
        loadFeed(undefined, q);
      } else if (searchActive) {
        // Search was cleared — reload normal feed
        loadFeed();
      }
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, auth]);

  // Infinite scroll: load the next older page when the sentinel enters view.
  useEffect(() => {
    if (!feedSentinelRef.current) return;
    const el = feedSentinelRef.current;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreFeed();
      },
      { rootMargin: "400px 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, feedLoading, feedHasMore, feedLoadingMore, feedPosts.length, threadPost]);

  const requestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/auth/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const d = await r.json();
      if (!r.ok) setMsg({ type: "err", text: d.error || "エラー" });
      else {
        setSentTo(email);
        setView("otp");
        setCode("");
        setMsg({ type: "ok", text: d.message || "送信しました" });
      }
    } catch {
      setMsg({ type: "err", text: "通信エラー" });
    } finally {
      setBusy(false);
    }
  };

  const verifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: sentTo, code }),
      });
      const d = await r.json();
      if (!r.ok) setMsg({ type: "err", text: d.error || "認証失敗" });
      else {
        setAuth({ email: d.email });
        setMsg(null);
        checkAuth();
      }
    } catch {
      setMsg({ type: "err", text: "通信エラー" });
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setAuth(null);
    setFeedPosts([]);
  };

  // ---- Image upload ----
  // Resize/compress an image client-side via Canvas so files stay under the
  // 10MB-per-image limit and are lighter to serve. Returns the original File
  // unchanged if it's already small/likely to fit.
  const resizeImage = (file: File, maxW = 2560, quality = 0.85): Promise<Blob> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new window.Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          URL.revokeObjectURL(url);
          reject(new Error("画像処理に失敗しました"));
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        // Only produce JPEG if the source isn't a PNG (keep transparency for
        // PNGs, but they're rare in photos).
        if (file.type === "image/png") {
          canvas.toBlob(
            (b) => (b ? resolve(b) : resolve(file)),
            "image/png"
          );
        } else {
          canvas.toBlob(
            (b) => (b ? resolve(b) : resolve(file)),
            "image/jpeg",
            quality
          );
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("画像の読み込みに失敗しました"));
      };
      img.src = url;
    });

  // Generic image upload shared by the main composer, thread reply box and
  // inline reply box. Resizes/compresses client-side, posts to /api/upload,
  // then appends the returned URLs to the given state setter.
  const uploadImages = async (
    files: FileList | null,
    current: string[],
    setter: (fn: (prev: string[]) => string[]) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void
  ) => {
    if (!files || files.length === 0) return;
    const usable = Array.from(files).slice(0, Math.max(0, 5 - current.length));
    if (usable.length === 0) return;
    setUp(true);
    setErr("");
    try {
      const fd = new FormData();
      for (const f of usable) {
        // Downscale when a single file could exceed the 10MB server limit.
        if (f.size > 10 * 1024 * 1024) {
          const resized = await resizeImage(f);
          const name = f.name.replace(/\.[^.]+$/, "") + ".jpg";
          fd.append("images", new File([resized], name, { type: "image/jpeg" }));
        } else {
          fd.append("images", f);
        }
      }
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "アップロード失敗");
      setter((prev) => [...prev, ...d.urls]);
    } catch (err: any) {
      setErr(err.message);
    } finally {
      setUp(false);
    }
  };

  const onPickImages = (files: FileList | null) =>
    uploadImages(files, pendingImages, setPendingImages, setUploading, (s) => setPostError(s));

  const onThreadReplyPick = (files: FileList | null) =>
    uploadImages(files, threadReplyImages, setThreadReplyImages, setThreadUploading, (s) =>
      setReplyError(s)
    );

  const onInlineReplyPick = (files: FileList | null) =>
    uploadImages(files, inlineReplyImages, setInlineReplyImages, setInlineUploading, (s) => {
      // Only append a real error to the box text. The helper calls setErr("")
      // to CLEAR the error at the start of an upload, so ignore empty strings
      // (otherwise a stray "(エラー: )" would be typed into the input).
      if (s) setInlineReplyText((prev) => prev + (prev ? "\n\n" : "") + "(エラー: " + s + ")");
    });

  const removeThreadReplyImage = (i: number) =>
    setThreadReplyImages((prev) => prev.filter((_, idx) => idx !== i));

  const removeInlineReplyImage = (i: number) =>
    setInlineReplyImages((prev) => prev.filter((_, idx) => idx !== i));

  const removeImage = (i: number) => {
    setPendingImages((prev) => prev.filter((_, idx) => idx !== i));
  };

  const submitPost = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const text = postText.trim();
      if ((!text && pendingImages.length === 0) || posting) return;
      setPosting(true);
      setPostError(null);
      try {
        const r = await fetch("/api/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, images: pendingImages }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "投稿失敗");
        setPostText("");
        setPendingImages([]);
        // Insert the returned post at the top of the feed (no full reload).
        // This works now that createPost returns a complete FeedPost object
        // (with lastActivityAt, parentId, authorAvatar, etc.) and the SSE
        // self-event skip prevents a redundant silentRefreshFeed from racing.
        if (d.post) {
          setFeedPosts((prev) => {
            if (prev.some((p) => p.id === d.post.id)) return prev;
            return [d.post, ...prev];
          });
        }
      } catch (err: any) {
        setPostError(err.message);
      } finally {
        setPosting(false);
      }
    },
    [postText, pendingImages, posting]
  );

  // Reply button: open that post's thread view and show the reply box.
  // Single path — no separate reply popup anymore.
  const openThreadReply = (postId: number) => {
    setReplyText("");
    setThreadReplyImages([]);
    setReplyError(null);
    setThreadWhisper(false);
    openThread(postId);
    setThreadReplyBoxOpen(true);
  };

  // Whisper to the currently open thread post: posts a whisper reply
  // (is_whisper=true) that does NOT bump the group in the timeline.
  const submitWhisperThread = (parentId: number) => {
    setThreadReplyBoxOpen(true);
    setThreadWhisper(true);
    setReplyText("");
    setReplyError(null);
  };

  // Submit a reply from within the thread view. whisper=true posts it as a
  // whisper (is_whisper) so the group does NOT bump to the top of the timeline.
  const submitThreadReply = async (whisper = false) => {
    if (!threadPost || replying) return;
    const text = replyText.trim();
    if (!text && threadReplyImages.length === 0) return;
    setReplying(whisper ? 'whisper' : 'comment');
    setReplyError(null);
    // Optimistically add the reply to the thread view immediately.
    const tempId = Date.now();
    const tempReply: FeedPost = {
      id: tempId,
      authorEmail: auth?.email ?? "",
      authorName: auth?.name ?? null,
      authorAvatar: avatarSrc ?? null,
      parentId: threadPost.id,
      text,
      images: threadReplyImages,
      urlPreview: null,
      likeCount: 0,
      likedByMe: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      replies: [],
      replyCount: 0,
    };
    setThreadReplies((prev) => [...prev, tempReply]);
    setReplyText("");
    setThreadReplyImages([]);
    setThreadWhisper(false);
    try {
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images: tempReply.images, parentId: threadPost.id, whisper }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "返信失敗");
      // Replace the temp reply with the real one.
      const created = d.post;
      setThreadReplies((prev) =>
        prev.map((rp) =>
          rp.id === tempId
            ? {
                ...created,
                id: created.id,
                authorEmail: created.authorEmail,
                authorName: created.authorName ?? null,
                authorAvatar: created.authorAvatar ?? null,
                parentId: threadPost.id,
                text: created.text ?? "",
                images: created.images ?? [],
                urlPreview: created.urlPreview ?? null,
                likeCount: 0,
                likedByMe: false,
                createdAt: new Date(created.createdAt).toISOString(),
                lastActivityAt: new Date(created.createdAt).toISOString(),
                replies: [],
                replyCount: 0,
              }
            : rp
        )
      );
      // Also update the feed's inline replies for this post.
      setFeedPosts((prev) => appendReplyLocal(prev, threadPost.id, created, !!whisper));
      // Scroll to the newly posted reply inside the thread view.
      requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-reply-id="${created.id}"]`
        ) as HTMLElement | null;
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("pin-target-flash");
          window.setTimeout(() => el.classList.remove("pin-target-flash"), 2400);
        }
      });
    } catch (err: any) {
      // Rollback: remove the optimistic reply.
      setThreadReplies((prev) => prev.filter((rp) => rp.id !== tempId));
      setReplyError(err.message);
      // Restore the text so the user can retry.
      setReplyText(text);
    } finally {
      setReplying(false);
    }
  };

  // ---- Inline "insert between cards" comment (timeline group) ----
  const toggleInlineReply = (postId: number) => {
    setInlineReplyFor((prev) => (prev === postId ? null : postId));
    setInlineReplyText("");
    setInlineReplyImages([]);
    setInlineWhisper(false);
  };
  // Whisper: open the same inline box in whisper mode (reply stays in place).
  const toggleWhisper = (postId: number) => {
    setInlineWhisper(true);
    // If already open for this post, keep it; otherwise open it.
    setInlineReplyFor((prev) => (prev === postId ? prev : postId));
    setInlineReplyText("");
    setInlineReplyImages([]);
  };
  const submitInlineReply = async (postId: number, whisper?: boolean) => {
    const isWhisper = whisper ?? inlineWhisper;
    const text = inlineReplyText.trim();
    if ((!text && inlineReplyImages.length === 0) || inlineReplying) return;
    setInlineReplying(isWhisper ? 'whisper' : 'comment');
    // Optimistically insert the reply into the feed IMMEDIATELY (before the
    // network round-trip) so the user sees instant feedback.  Clear the
    // input box right away — this also prevents double-submits because the
    // text is gone and inlineReplying is non-false while the request is
    // in-flight.
    const tempId = Date.now(); // temporary ID until the server responds
    const tempReply: FeedPost = {
      id: tempId,
      authorEmail: auth?.email ?? "",
      authorName: auth?.name ?? null,
      authorAvatar: avatarSrc ?? null,
      parentId: postId,
      text,
      images: inlineReplyImages,
      urlPreview: null,
      likeCount: 0,
      likedByMe: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      replies: [],
      replyCount: 0,
    };
    setInlineReplyFor(null);
    setInlineReplyText("");
    setInlineReplyImages([]);
    setFeedPosts((prev) => appendReplyLocal(prev, postId, tempReply, !!isWhisper));
    try {
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images: tempReply.images, parentId: postId, whisper: isWhisper }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "コメント失敗");
      // Replace the temporary reply with the real one from the server.
      const created = d.post;
      setFeedPosts((prev) => {
        const replaceTemp = (root: FeedPost): FeedPost => {
          if (root.id !== postId && !(root.replies ?? []).some((rp) => rp.id === postId)) return root;
          // Remove BOTH the temp reply (tempId) AND any stale server reply
          // with the same real ID (could've been brought in by a silentRefreshFeed
          // that raced between our optimistic insert and this replacement).
          const filtered = (root.replies ?? []).filter(
            (rp) => rp.id !== tempId && rp.id !== created.id
          );
          const realReply: FeedPost = {
            id: created.id,
            authorEmail: created.authorEmail,
            authorName: created.authorName ?? null,
            authorAvatar: created.authorAvatar ?? null,
            parentId: postId,
            text: created.text ?? "",
            images: created.images ?? [],
            urlPreview: created.urlPreview ?? null,
            likeCount: 0,
            likedByMe: false,
            createdAt: new Date(created.createdAt).toISOString(),
            lastActivityAt: new Date(created.createdAt).toISOString(),
            replies: [],
            replyCount: 0,
          };
          const replies = [...filtered, realReply];
          replies.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
          return { ...root, replies };
        };
        return prev.map(replaceTemp);
      });
      // Scroll to the parent post so the user sees their comment in context.
      // For normal comments the group bumped to the top; for whispers it
      // stayed in place. Either way, scroll to the parent card.
      pendingScrollRef.current = postId;
    } catch (err: any) {
      // Rollback: remove the optimistic reply and restore the text.
      setFeedPosts((prev) => {
        const removeTemp = (root: FeedPost): FeedPost => {
          if (root.id !== postId && !(root.replies ?? []).some((rp) => rp.id === postId)) return root;
          const replies = (root.replies ?? []).filter((rp) => rp.id !== tempId);
          return {
            ...root,
            replies,
            replyCount: Math.max(0, (root.replyCount ?? 0) - 1),
          };
        };
        return prev.map(removeTemp);
      });
      setInlineReplyText(text + "\n\n(エラー: " + err.message + ")");
    } finally {
      setInlineReplying(false);
    }
  };

  // Open the individual thread view (post + chronological replies)
  const openThread = (postId: number) => {
    setThreadLoading(true);
    setThreadPost(null);
    setThreadReplies([]);
    setReplyText("");
    setThreadReplyImages([]);
    setThreadReplyBoxOpen(false);
    setThreadWhisper(false);
    setReplyError(null);
    // Allow the browser back button to close the thread view.
    window.history.pushState({ thread: postId }, "", `#/post/${postId}`);
    fetch(`/api/posts/${postId}`, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "取得失敗");
        setThreadPost(d.post);
        setThreadReplies(d.replies ?? []);
      })
      .catch((err) => setReplyError(err.message))
      .finally(() => setThreadLoading(false));
  };

  const closeThread = () => {
    // If we navigated to a #/post hash, go back so the URL (and browser back
    // history) returns to the timeline; popstate handler resets the state.
    if (/(^|\/)#?\/?post\//.test(window.location.hash) || (window.location.hash || "").startsWith("#/post/")) {
      window.history.back();
    } else {
      setThreadPost(null);
      setThreadReplies([]);
      // Use silent diff refresh instead of full reload — preserves scroll
      // position and loaded older pages while syncing reply counts.
      silentRefreshFeed();
    }
  };

  // Return to the top/home (feed) view from anywhere — including from a thread.
  const goHome = () => {
    setActiveNav("feed");
    setThreadPost(null);
    setThreadReplies([]);
    setInlineReplyFor(null);
    setNavOpened(false);
    // Clear search when going home
    if (searchQuery) setSearchQuery("");
    if (window.location.hash.startsWith("#/post/")) {
      // Replace the hash so we don't leave the thread in history.
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // ignore
      }
    }
    // NOTE: removed silentRefreshFeed() here — when navigating back to the
    // feed from another nav, the activeNav Effect calls loadFeed() which is
    // the authoritative full reload. Calling silentRefreshFeed in the same
    // tick caused a race with loadFeed's setFeedLoading(true). When already
    // on the feed, the SSE connection keeps the timeline live anyway.
    // Smoothly scroll the timeline back to the top.
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  // Toggle like optimistically on the feed list AND the current thread view
  // (threadPost + threadReplies use separate state, so update both). Also
  // recurse into nested replies (inline group comments) so their likes update.
  const toggleLikeLocal = (postId: number) => {
    const flip = (p: any) => {
      const hit = p.id === postId;
      const next = hit
        ? { ...p, likedByMe: !p.likedByMe, likeCount: p.likeCount + (p.likedByMe ? -1 : 1) }
        : p;
      if (p.replies?.length) next.replies = p.replies.map(flip);
      return next;
    };
    setFeedPosts((prev) => prev.map(flip));
    setThreadPost((prev) => (prev && (prev.id === postId || prev.replies?.some((r: any) => r.id === postId)) ? flip(prev) : prev));
    setThreadReplies((prev) => prev.map(flip));
  };

  const toggleLikeRequest = (postId: number) => {
    fetch(`/api/posts/${postId}/like`, { method: "POST" })
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return;
        // Sync from server response (feed + thread view)
        const sync = (p: any) => {
          const next = p.id === postId ? { ...p, likedByMe: d.liked, likeCount: d.likeCount } : p;
          if (p.replies?.length) next.replies = p.replies.map(sync);
          return next;
        };
        setFeedPosts((prev) => prev.map(sync));
        setThreadPost((prev) => (prev && (prev.id === postId || prev.replies?.some((r: any) => r.id === postId)) ? sync(prev) : prev));
        setThreadReplies((prev) => prev.map(sync));
      })
      .catch(() => {});
  };

  // Optimistic + server sync
  const handleLike = (postId: number) => {
    toggleLikeLocal(postId);
    toggleLikeRequest(postId);
  };

  // Pin / unpin own post. The right-sidebar panel is the canonical home for
  // pins now, so refresh it (and the feed) when a pin changes.
  const handlePin = (postId: number) => {
    fetch(`/api/posts/${postId}/pin`, { method: "POST" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "ピン更新失敗");
        loadFeed();
        loadPinned();
      })
      .catch((err) => setActionError(err.message));
  };

  // Scroll the timeline to a pinned post's card, briefly highlighting it, so the
  // user sees it in context with the surrounding posts. If the post isn't in the
  // already-loaded feed, wait for a fresh load (pinned posts are recent, so they
  // usually appear on the first page after switching back to ホーム), then page
  // back in time (bounded); as a last resort open the thread view.
  const scrollToPinnedPost = async (postId: number) => {
    // Close the mobile right sidebar (aside overlay) so the user sees the
    // timeline scroll happen. On desktop the aside is always visible and this
    // is a no-op.
    setAsideOpened(false);
    // Flag this card as "loading" so the sidebar shows a spinner on it while we
    // page back to fetch the (possibly not-yet-loaded) post.
    setScrollingPostId(postId);
    const nav = activeNavRef.current;
    if (nav !== "feed") setActiveNav("feed");

    const findEl = () =>
      document.querySelector(
        `[data-post-id="${postId}"]`
      ) as HTMLElement | null;

    const revealAndScroll = (el: HTMLElement) => {
      setScrollingPostId(null);
      el.classList.add("pin-target-flash");
      window.setTimeout(() => el.classList.remove("pin-target-flash"), 2400);
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    // 1) Fast path — the post is already rendered in the loaded feed.
    let el = findEl();
    if (el) {
      revealAndScroll(el);
      return;
    }

    // 2) Brief wait for a feed reload right after switching nav.
    const reloadDeadline = Date.now() + 800;
    while (Date.now() < reloadDeadline) {
      await new Promise((r) => window.setTimeout(r, 90));
      el = findEl();
      if (el) {
        revealAndScroll(el);
        return;
      }
    }

    // 3) Not rendered — page back in time from the current cursor, appending
    //    each page until the post is fetched, then wait for React to actually
    //    commit the newly appended groups (double rAF = next paint) before we
    //    attempt the scroll. This is the reliable "jump" that works on the
    //    first click even when the post is buried in older history.
    let guard = 0;
    let cursor = feedCursorRef.current;
    while (guard < 80 && cursor) {
      const q = `?limit=${FEED_PAGE}&before=${encodeURIComponent(cursor)}`;
      let d: any = null;
      try {
        d = await fetch(`/api/posts${q}`).then((r) => r.json());
      } catch {
        break;
      }
      const posts: FeedPost[] = d?.posts ?? [];
      if (posts.length === 0) break;
      const hit = posts.some((p) => p.id === postId);
      setFeedPosts((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        const merged = [...prev];
        for (const np of posts) if (!seen.has(np.id)) merged.push(np);
        return merged;
      });
      cursor = posts[posts.length - 1].lastActivityAt ?? posts[posts.length - 1].createdAt;
      guard += 1;
      if (hit) {
        // Let React render the appended cards, then scroll to them.
        await new Promise((r) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(() => r(null)))
        );
        await new Promise((r) => window.setTimeout(r, 80));
        el = findEl();
        if (el) {
          revealAndScroll(el);
          return;
        }
        break;
      }
    }

    // 4) Last resort — open the thread view so the post is always reachable.
    setScrollingPostId(null);
    openThread(postId);
  };

  // Edit post
  const openEdit = (post: FeedPost) => {
    setEditingPost(post);
    setEditText(post.text);
    setEditImages([...post.images]);
    setActionError(null);
  };

  const onEditPickImages = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const usable = Array.from(files).slice(0, Math.max(0, 5 - editImages.length));
    if (usable.length === 0) return;
    const fd = new FormData();
    usable.forEach((f) => fd.append("images", f));
    fetch("/api/upload", { method: "POST", body: fd })
      .then((r) => r.json())
      .then((d) => {
        if (d.urls) setEditImages((prev) => [...prev, ...d.urls]);
        else setActionError(d.error || "アップロード失敗");
      })
      .catch(() => setActionError("アップロードに失敗しました"));
  };

  // Apply a mutation to a post wherever it currently appears — the feed
  // (root cards + their nested inline replies) AND the open thread view
  // (threadPost + threadReplies). Editing/deleting must update every state
  // slice that renders the same post; otherwise a change looks like it "did
  // not apply" until a full page reload (e.g. editing a post from inside a
  // thread view, or editing an inline reply which lives nested in the feed).
  const applyPostChange = (
    postId: number,
    mutate: (p: FeedPost) => FeedPost
  ) => {
    const apply = (p: FeedPost): FeedPost => {
      let next = p.id === postId ? mutate(p) : { ...p };
      if (next.replies?.length) {
        next = { ...next, replies: next.replies.map(apply) };
      }
      return next;
    };
    setFeedPosts((prev) => prev.map(apply));
    setThreadPost((prev) => (prev ? apply(prev) : prev));
    setThreadReplies((prev) => prev.map(apply));
  };

  const saveEdit = () => {
    if (!editingPost || savingEdit) return;
    setSavingEdit(true);
    setActionError(null);
    const editId = editingPost.id;
    const newText = editText.trim();
    const newImages = editImages;
    fetch(`/api/posts/${editId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: newText, images: newImages }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "更新失敗");
        setEditingPost(null);
        // Update the post in-place everywhere it's rendered (feed + thread)
        // without a full reload.
        applyPostChange(editId, (p) => ({ ...p, text: newText, images: newImages }));
      })
      .catch((err) => setActionError(err.message))
      .finally(() => setSavingEdit(false));
  };

  // Delete post
  const confirmDelete = () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setActionError(null);
    const deletedId = deleteTarget.id;
    fetch(`/api/posts/${deletedId}`, { method: "DELETE" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "削除失敗");
        setDeleteTarget(null);
        // Remove the post from every state slice (feed root + nested replies,
        // and the open thread view) without a full reload.
        setFeedPosts((prev) =>
          prev
            .filter((p) => p.id !== deletedId)
            .map((p) => ({
              ...p,
              replies: (p.replies ?? []).filter((rp) => rp.id !== deletedId),
            }))
        );
        setThreadReplies((prev) => prev.filter((rp) => rp.id !== deletedId));
        setThreadPost((prev) => {
          if (!prev) return prev;
          if (prev.id === deletedId) return null;
          return {
            ...prev,
            replies: (prev.replies ?? []).filter((rp) => rp.id !== deletedId),
          };
        });
      })
      .catch((err) => setActionError(err.message))
      .finally(() => setDeleting(false));
  };

  // Cmd/Ctrl + Enter to submit
  const onComposerKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      // Avoid firing during IME composition
      if ((e.nativeEvent as any).isComposing) return;
      e.preventDefault();
      submitPost();
    }
  };

  // Close full-screen lightbox with Escape
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewImage(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewImage]);

  // ---------- Auth gates ----------
  if (checking) {
    return (
      <main className="flex-1 w-full min-h-screen flex items-center justify-center ">
        <Text c="dimmed">読み込み中…</Text>
      </main>
    );
  }

  if (!auth) {
    return (
      <main className="flex-1 w-full max-w-md mx-auto px-6 py-16 ">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-400 font-black text-2xl text-white shadow-lg mb-5">
            B
          </div>
          <Title order={1} fw={900} c="inherit">
            B-guru
          </Title>
          <Text size="sm" c="dimmed" mt={8}>
            backspace.fm の有料会員向けコンテンツ
          </Text>
        </div>

        <Paper radius="lg" p="lg" withBorder shadow="sm">
          {view === "login" ? (
            <form onSubmit={requestOtp} className="space-y-4">
              <TextInput
                label="登録メールアドレス"
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.currentTarget.value)}
              />
              <Button fullWidth type="submit" loading={busy} color="green">
                認証コードを送信
              </Button>
              <Text size="xs" c="dimmed">
                あなたが B-guru（backspace.fm 有料会員サービス）の会員として登録しているメールアドレスに、ログイン認証コードを送信します。
              </Text>
            </form>
          ) : (
            <form onSubmit={verifyOtp} className="space-y-4">
              <Box>
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => {
                    setView("login");
                    setMsg(null);
                  }}
                >
                  ← メールを変更
                </Button>
              </Box>
              <TextInput
                label={`${sentTo} に送信した認証コード`}
                required
                placeholder="6桁のコード"
                value={code}
                onChange={(e) => setCode(e.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
              />
              <Button
                fullWidth
                type="submit"
                loading={busy}
                disabled={code.length !== 6}
                color="green"
              >
                ログイン
              </Button>
            </form>
          )}
          {msg && (
            <Text size="sm" mt="md" c={msg.type === "ok" ? "green" : "red"}>
              {msg.text}
            </Text>
          )}
        </Paper>
      </main>
    );
  }

  // ---------- Logged-in: 3-column shell ----------
  const isCenterView = ["feed", "gallery", "news", "episodes"].includes(activeNav);

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { mobile: !navOpened } }}
      aside={{ width: 280, breakpoint: "lg", collapsed: { mobile: !asideOpened } }}
      padding={0}
    >
      {/* Header */}
      <AppShell.Header style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border-default)" }}>
        <div
          style={{
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 16px",
            position: "relative",
          }}
        >
          {/* Left: hamburger (wordmark removed — the centered logo is the brand) */}
          <Group gap="xs" wrap="nowrap">
            <Burger
              opened={navOpened}
              onClick={() => setNavOpened((o) => !o)}
              size="sm"
              hiddenFrom="sm"
            />
          </Group>
          {/* Center: site logo (blue leaping dog) */}
          <UnstyledButton
            onClick={goHome}
            aria-label="タイムラインへ戻る"
            style={{
              cursor: "pointer",
              background: "transparent",
              border: "none",
              padding: 0,
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              lineHeight: 0,
            }}
          >
            <Image
              src="/icon-192.png"
              alt="B-guru"
              w={28}
              h={28}
              fit="contain"
              style={{ display: "block", borderRadius: 6 }}
            />
          </UnstyledButton>
          <Group gap="sm" wrap="nowrap">
            <Group gap={8} visibleFrom="sm">
              <Avatar src={avatarSrc} alt={displayName} radius="xl" size="sm" color="green">
                {displayName.charAt(0).toUpperCase()}
              </Avatar>
              <div style={{ lineHeight: 1.2 }}>
                <Text size="sm" fw={600} c="inherit">
                  {auth.name || auth.email}
                </Text>
                <Text size="xs" c="dimmed">
                  {auth.name ? auth.email : ""}
                </Text>
              </div>
            </Group>
            {/* Bell icon removed — notifications moved to the right sidebar (below search).
                Unread badge is now on the right Burger for symmetry. */}
            <Indicator
              inline
              size={16}
              offset={4}
              color="red"
              label={notifUnread > 9 ? "9+" : notifUnread}
              disabled={notifUnread === 0}
            >
              <Burger
                opened={asideOpened}
                onClick={() => setAsideOpened((o) => !o)}
                size="sm"
                hiddenFrom="lg"
                aria-label="右パネルを開く"
              />
            </Indicator>
            <Button variant="default" size="xs" onClick={logout} visibleFrom="sm">
              ログアウト
            </Button>
          </Group>
        </div>
      </AppShell.Header>

      {/* Left sidebar */}
      <AppShell.Navbar p="xs" style={{ background: "var(--bg-surface)", borderRight: "1px solid var(--border-default)" }}>
        <ScrollArea>
          <Stack gap={2}>
            <Text size="xs" fw={700} c="dimmed" p="xs">
              メニュー
            </Text>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.key}
                active={activeNav === item.key}
                label={item.label}
                leftSection={<span>{item.icon}</span>}
                onClick={() => {
                  if (item.key === "feed") {
                    // "タイムライン" should always return to the full timeline
                    // (closing any open thread) and scroll to top — matching the
                    // in-feed "タイムラインに戻る" button so the two feel consistent.
                    goHome();
                  } else {
                    setActiveNav(item.key);
                  }
                  setNavOpened(false);
                }}
                style={{
                  borderRadius: 8,
                  marginBottom: 2,
                  ...(activeNav === item.key
                    ? { background: "var(--bg-tinted)", color: "var(--text-green)", fontWeight: 600 }
                    : {}),
                }}
              />
            ))}

            {/* Admin-managed external-link bookmarks */}
            {menuLinks.map((lk) => (
              <div
                key={lk.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  borderRadius: 8,
                  marginBottom: 2,
                }}
              >
                <a
                  href={lk.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    flex: 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 8,
                    color: "var(--text-primary)",
                    textDecoration: "none",
                    fontSize: 14,
                    minWidth: 0,
                  }}
                >
                  <span style={{ fontSize: 16 }}>{lk.icon || "🔗"}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {lk.label}
                  </span>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>↗</span>
                </a>
                {isAdminAuth && (
                  <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label="リンクを編集"
                      onClick={() => openEditLink(lk)}
                    >
                      <svg
                        width="15"
                        height="15"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </ActionIcon>
                    {confirmDeleteId === lk.id ? (
                      <Group gap={2} wrap="nowrap">
                        <ActionIcon
                          variant="subtle"
                          color="green"
                          size="sm"
                          aria-label="削除を確定"
                          onClick={() => removeLink(lk.id)}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M20 6 9 17l-5-5" />
                          </svg>
                        </ActionIcon>
                        <ActionIcon
                          variant="subtle"
                          color="gray"
                          size="sm"
                          aria-label="削除をキャンセル"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          <svg
                            width="15"
                            height="15"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <path d="M18 6 6 18M6 6l12 12" />
                          </svg>
                        </ActionIcon>
                      </Group>
                    ) : (
                      <ActionIcon
                        variant="subtle"
                        color="red"
                        size="sm"
                        aria-label="リンクを削除"
                        onClick={() => setConfirmDeleteId(lk.id)}
                      >
                        <svg
                          width="15"
                          height="15"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M3 6h18" />
                          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        </svg>
                      </ActionIcon>
                    )}
                  </Group>
                )}
              </div>
            ))}
            {isAdminAuth && (
              <Button
                variant="subtle"
                size="xs"
                color="green"
                leftSection={<span style={{ fontSize: 16, lineHeight: 1 }}>+</span>}
                onClick={openAddLink}
                style={{ justifyContent: "flex-start", marginTop: 4, fontWeight: 500 }}
              >
                外部リンクを追加
              </Button>
            )}
          </Stack>
        </ScrollArea>
        {/* Dark mode toggle — bottom of left sidebar to preserve header symmetry */}
        <Divider my="xs" />
        <UnstyledButton
          onClick={() => toggleColorScheme()}
          aria-label={isDark ? "ライトモードに切替" : "ダークモードに切替"}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 8,
            color: "var(--text-primary)",
            fontSize: 14,
            width: "100%",
          }}
        >
          {isDark ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
          <span>{isDark ? "ライトモード" : "ダークモード"}</span>
        </UnstyledButton>
      </AppShell.Navbar>

      {/* Right sidebar: visible only on very wide screens. Hosts the pinned-post
       *  summary cards (pins were moved here from the timeline). */}
      <AppShell.Aside p="md" style={{ background: "var(--bg-primary)", borderLeft: "1px solid var(--border-default)" }}>
        <ScrollArea>
          <Stack gap="sm">
          {/* Search box */}
          <Paper p="sm" radius="md" withBorder shadow="xs">
            <TextInput
              placeholder="タイムラインを検索"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              size="sm"
              leftSection={
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              }
              rightSection={
                searchQuery ? (
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => setSearchQuery("")}
                    aria-label="検索をクリア"
                  >
                    ×
                  </ActionIcon>
                ) : null
              }
              aria-label="タイムラインを検索"
            />
            {searchActive && (
              <Text size="xs" c="green" mt={6}>
                「{searchQuery}」で検索中
              </Text>
            )}
          </Paper>

          {/* Notifications panel (moved here from header popover) */}
          <Paper p={0} radius="md" withBorder shadow="xs">
            <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid var(--border-default)" }}>
              <Group gap={6} align="center" wrap="nowrap">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                  <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                </svg>
                <Text fw={700} size="sm" c="inherit">
                  通知
                </Text>
                {notifUnread > 0 && (
                  <Badge size="sm" color="red" variant="filled">
                    {notifUnread > 9 ? "9+" : notifUnread}
                  </Badge>
                )}
              </Group>
              {notifUnread > 0 && (
                <Button size="xs" variant="subtle" color="gray" onClick={markAllNotifRead}>
                  すべて既読
                </Button>
              )}
              {notifications.length > 0 && (
                <Button size="xs" variant="subtle" color="red" onClick={clearAllNotif}>
                  クリア
                </Button>
              )}
            </Group>
            <ScrollArea.Autosize mah={360} type="auto">
              {notifications.length === 0 ? (
                <Text c="dimmed" size="sm" p="md">
                  通知はありません
                </Text>
              ) : (
                notifications.map((n) => (
                  <Box
                    key={n.id}
                    p="sm"
                    style={{
                      cursor: "pointer",
                      borderBottom: "1px solid var(--border-light)",
                      background: n.readAt ? "var(--bg-surface)" : "var(--bg-tinted)",
                    }}
                    onClick={() => {
                      setAsideOpened(false);
                      handleNotifClick(n);
                    }}
                  >
                    <Group gap="xs" align="flex-start" wrap="nowrap">
                      <Text size="lg" style={{ lineHeight: 1 }}>
                        {n.type === "reply" ? "💬" : n.type === "mention" ? "📢" : "❤️"}
                      </Text>
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" c="inherit" style={{ wordBreak: "break-word" }}>
                          <b>{n.actorName || n.actorEmail.split("@")[0]}</b>
                          {n.type === "reply" ? " があなたの投稿に返信しました" : n.type === "mention" ? " があなたをメンションしました" : " があなたの投稿にいいねしました"}
                        </Text>
                        {n.text ? (
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            「{n.text}」
                          </Text>
                        ) : null}
                        <Text size="xs" c="gray">
                          {new Date(n.createdAt).toLocaleString("ja-JP")}
                        </Text>
                      </div>
                    </Group>
                  </Box>
                ))
              )}
            </ScrollArea.Autosize>
          </Paper>

          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Group justify="space-between" align="center" mb={4} wrap="nowrap">
              <Group gap={6} align="center" wrap="nowrap">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="none"
                  color="var(--text-green)"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="5" />
                </svg>
                <Text fw={700} size="sm">
                  オンライン
                </Text>
              </Group>
              {onlineMembers.length > 0 && (
                <Text size="xs" c="dimmed">
                  {onlineMembers.length}人
                </Text>
              )}
            </Group>
            {onlineMembers.length === 0 ? (
              <Text size="xs" c="dimmed">
                現在オンラインのメンバーはいません。
              </Text>
            ) : (
              <Stack gap={4}>
                {onlineMembers.map((m) => {
                  const isSelf = !!auth && m.email === auth.email;
                  return (
                    <UnstyledButton
                      key={m.email}
                      title={
                        isSelf
                          ? "自分に手を振る（動作確認）"
                          : `${m.name || m.email} に手を振る`
                      }
                      onClick={() =>
                        isSelf
                          ? showWave("自分", "received")
                          : sendWave(m.email, m.name || m.email)
                      }
                      style={{
                        display: "block",
                        width: "100%",
                        textAlign: "left",
                        borderRadius: 8,
                        padding: "3px 4px",
                        cursor: "pointer",
                      }}
                    >
                      <Group
                        gap={8}
                        align="center"
                        wrap="nowrap"
                        style={{ minWidth: 0 }}
                      >
                        <SafeAvatar src={m.avatar} initial={m.name || m.email} size="sm" />
                        <Text size="sm" truncate style={{ minWidth: 0 }}>
                          {m.name || m.email}
                          {isSelf && (
                            <Text span c="green" fw={600}>
                              （あなた）
                            </Text>
                          )}
                        </Text>
                        {!isSelf && (
                          <Text span c="dimmed" size="sm" ml="auto">
                            👋
                          </Text>
                        )}
                      </Group>
                    </UnstyledButton>
                  );
                })}
              </Stack>
            )}
          </Paper>

          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Group justify="space-between" align="center" mb={4} wrap="nowrap">
              <Group gap={6} align="center" wrap="nowrap">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="none"
                  color="var(--text-green)"
                  aria-hidden="true"
                >
                  <path d="M12 17v5" />
                  <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
                </svg>
                <Text fw={700} size="sm">
                  ピン留め
                </Text>
              </Group>
              {pinnedLoading && <Loader size="xs" color="green" />}
            </Group>
            {!pinnedLoading && pinnedPosts.length === 0 ? (
              <Text size="xs" c="dimmed">
                ピンはありません。自分の投稿の右上にあるピンアイコンから、その投稿を24時間ピン留めできます。
              </Text>
            ) : (
              <Stack gap={6}>
                {pinnedPosts.map((p) => (
                  <PinnedCard
                    key={p.id}
                    post={p}
                    onOpen={scrollToPinnedPost}
                    onUnpin={handlePin}
                    canUnpin={!!auth && auth.email === p.authorEmail}
                    loading={scrollingPostId === p.id}
                  />
                ))}
              </Stack>
            )}
          </Paper>

          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Group justify="space-between" align="center" mb={4} wrap="nowrap">
              <Group gap={6} align="center" wrap="nowrap">
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  stroke="none"
                  color="var(--text-green)"
                  aria-hidden="true"
                >
                  <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />
                </svg>
                <Text fw={700} size="sm">
                  ホットトピック
                </Text>
              </Group>
              {hotLoading && <Loader size="xs" color="green" />}
            </Group>
            {!hotLoading && hotPosts.length === 0 ? (
              <Text size="xs" c="dimmed">
                直近1週間で盛り上がっている投稿はまだありません。
              </Text>
            ) : (
              <Stack gap={6}>
                {hotPosts.map((p) => (
                  <HotTopicCard
                    key={p.id}
                    post={p}
                    onOpen={scrollToPinnedPost}
                    loading={scrollingPostId === p.id}
                  />
                ))}
              </Stack>
            )}
          </Paper>
          </Stack>
        </ScrollArea>
      </AppShell.Aside>

      {/* Main: feed or episodes */}
      <AppShell.Main
        style={{ background: "var(--bg-primary)", minHeight: "100vh" }}
        onClick={(e) => {
          // In thread view, tapping the wide left/right margin (or any area
          // outside the post cards/controls) returns to the timeline.
          if (!threadPost) return;
          const t = e.target as HTMLElement;
          if (t.closest(".mantine-Card-root, button, a, input, textarea, img, label")) return;
          closeThread();
        }}
      >
        <div
          className="mx-auto px-3 py-4 sm:px-6 sm:py-6"
          style={{ maxWidth: 640 }}
        >
          {isCenterView && (
            <Stack gap="md">
              {/* Composer (hidden on gallery/news? show only on home feed, and not during search) */}
              {activeNav === "feed" && !threadPost && !searchActive && (
                <Paper p="md" radius="md" withBorder shadow="sm">
                  <Group align="flex-start" gap="sm" mb="xs">
                    <Avatar src={avatarSrc} alt={displayName} radius="xl" size="md" color="green">
                      {displayName.charAt(0).toUpperCase()}
                    </Avatar>
                    <Text fw={600} size="sm" c="inherit">
                      {auth.name || auth.email}
                    </Text>
                  </Group>
                  <form onSubmit={submitPost}>
                    <MentionTextarea
                      placeholder="今なにしてる？ (画像投稿もできます)"
                      autosize
                      minRows={2}
                      value={postText}
                      onChange={setPostText}
                      onKeyDown={onComposerKeyDown}
                      mb="sm"
                    />
                    {pendingImages.length > 0 && (
                      <Group gap="xs" mb="sm">
                        {pendingImages.map((src, i) => (
                          <Box key={i} style={{ position: "relative" }}>
                            <Image
                              src={src}
                              width={72}
                              height={72}
                              fit="contain"
                              radius="md"
                              style={{ cursor: "pointer" }}
                              onClick={() => setPreviewImage(src)}
                            />
                            <ActionIcon
                              size="sm"
                              variant="filled"
                              color="red"
                              radius="xl"
                              style={{ position: "absolute", top: -6, right: -6 }}
                              onClick={() => removeImage(i)}
                            >
                              ×
                            </ActionIcon>
                          </Box>
                        ))}
                      </Group>
                    )}
                    <Group justify="space-between">
                      <Group gap="xs">
                        <Button
                          size="xs"
                          variant="light"
                          color="gray"
                          loading={uploading}
                          disabled={pendingImages.length >= 5}
                          onClick={() => fileInputRef.current?.click()}
                        >
                          📷 {pendingImages.length}/5
                        </Button>
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept="image/*"
                          multiple
                          hidden
                          onChange={(e) => {
                            onPickImages(e.target.files);
                            e.target.value = "";
                          }}
                        />
                        <Text size="xs" c="dimmed">
                          Cmd/Ctrl + Enter で投稿
                        </Text>
                      </Group>
                      <Button
                        type="submit"
                        size="sm"
                        color="green"
                        loading={posting}
                        disabled={(!postText.trim() && pendingImages.length === 0) || uploading}
                      >
                        投稿
                      </Button>
                    </Group>
                  </form>
                  {postError && (
                    <Text size="sm" mt="sm" c="red">
                      {postError}
                    </Text>
                  )}
                </Paper>
              )}

              {/* Section title (hidden during search — search has its own header) */}
              {searchActive && !threadPost && (
                <Group justify="space-between" align="center">
                  <Text fw={700} size="sm" c="inherit">
                    検索結果: {feedPosts.length}件
                  </Text>
                  <Button
                    variant="subtle"
                    size="xs"
                    color="gray"
                    onClick={() => setSearchQuery("")}
                  >
                    検索をクリア
                  </Button>
                </Group>
              )}
              {activeNav !== "feed" && !searchActive && (
                <Title order={3} c="inherit">
                  {activeNav === "gallery"
                    ? "🖼️ ギャラリー"
                    : activeNav === "news"
                    ? "📰 記事"
                    : "🎧 エピソード"}
                </Title>
              )}

              {/* Feed */}
              {feedLoading ? (
                <Text c="dimmed">読み込み中…</Text>
              ) : feedPosts.length === 0 ? (
                <Text c="dimmed">
                  {searchActive
                    ? `「${searchQuery}」に一致する投稿は見つかりませんでした`
                    : activeNav === "gallery"
                    ? "画像付きの投稿がまだありません"
                    : activeNav === "news"
                    ? "リンク付きの記事がまだありません"
                    : activeNav === "episodes"
                    ? "エピソードの投稿がまだありません"
                    : "投稿がまだありません。最初の投稿をしてみましょう！"}
                </Text>
              ) : threadPost ? (
                /* ---- Thread view: timeline filtered to one post + replies ---- */
                <Stack gap="md">
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={closeThread}
                    leftSection={<span style={{ fontSize: 12 }}>←</span>}
                    mb="xs"
                    color="gray"
                  >
                    タイムラインに戻る
                  </Button>
                  {threadLoading ? (
                    <Text c="dimmed">読み込み中…</Text>
                  ) : (
                    <>
                      {/* Root post */}
                      {threadPost && (
                        <PostCard
                          post={threadPost}
                          auth={auth}
                          mentionMembers={mentionMembers}
                          avatarSrc={avatarSrc}
                          isThreadRoot
                          showReplyButton={false}
                          onOpenThread={openThread}
                          onOpenThreadReply={openThreadReply}
                          onLike={handleLike}
                          onReply={openThreadReply}
                          onWhisper={submitWhisperThread}
                          onEdit={openEdit}
                          onDelete={setDeleteTarget}
                          onPin={handlePin}
                          onPreview={setPreviewImage}
                        />
                      )}

                      {/* Replies in chronological order */}
                      {threadReplies.length > 0 && <Divider label="返信" labelPosition="left" />}
                      {threadReplies.map((rep) => (
                        <Box key={rep.id} data-reply-id={rep.id}>
                        <PostCard
                          post={rep}
                          auth={auth}
                          mentionMembers={mentionMembers}
                          avatarSrc={avatarSrc}
                          showReplyButton={false}
                          onOpenThread={openThread}
                          onOpenThreadReply={openThread}
                          onLike={handleLike}
                          onReply={openThread}
                          onEdit={openEdit}
                          onDelete={setDeleteTarget}
                          onPin={handlePin}
                          onPreview={setPreviewImage}
                        />
                        </Box>
                      ))}
                      {threadReplies.length === 0 && (
                        <Text size="sm" c="dimmed">
                          まだ返信がありません。
                        </Text>
                      )}

                      {/* Reply box inside thread — always visible so a reply is
                          always possible without hunting for a button */}
                      <Paper p="sm" radius="md" withBorder>
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            submitThreadReply();
                          }}
                        >
                          <MentionTextarea
                            autosize
                            minRows={2}
                            placeholder={`${threadPost.authorName || "この投稿"} に返信…（Shift+Enter でささやく）`}
                            value={replyText}
                            onChange={setReplyText}
                            mb="xs"
                            onKeyDown={(e) => {
                              if ((e.nativeEvent as any).isComposing) return;
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                e.preventDefault();
                                submitThreadReply();
                              } else if (e.shiftKey && e.key === "Enter") {
                                e.preventDefault();
                                submitThreadReply(true);
                              }
                            }}
                          />
                          {threadReplyImages.length > 0 && (
                            <Group gap="xs" mb="xs">
                              {threadReplyImages.map((src, i) => (
                                <Box key={i} style={{ position: "relative" }}>
                                  <Image
                                    src={src}
                                    width={56}
                                    height={56}
                                    fit="contain"
                                    radius="md"
                                    style={{ cursor: "pointer" }}
                                    onClick={() => setPreviewImage(src)}
                                  />
                                  <ActionIcon
                                    size="sm"
                                    variant="filled"
                                    color="red"
                                    radius="xl"
                                    style={{ position: "absolute", top: -6, right: -6 }}
                                    onClick={() => removeThreadReplyImage(i)}
                                  >
                                    ×
                                  </ActionIcon>
                                </Box>
                              ))}
                            </Group>
                          )}
                          <Group gap="xs" mb="xs">
                            <label style={{ cursor: "pointer", display: "inline-block" }}>
                              <input
                                type="file"
                                accept="image/*"
                                multiple
                                hidden
                                onChange={(e) => {
                                  onThreadReplyPick(e.target.files);
                                  e.target.value = "";
                                }}
                              />
                              <Button
                                size="xs"
                                variant="light"
                                color="gray"
                                component="span"
                                loading={threadUploading}
                                disabled={threadReplyImages.length >= 5}
                              >
                                📷 {threadReplyImages.length}/5
                              </Button>
                            </label>
                          </Group>
                            {replyError && (
                              <Text size="sm" c="red" mb="xs">
                                {replyError}
                              </Text>
                            )}
                            <Group justify="space-between" align="center" gap="xs">
                              <Button
                                size="xs"
                                variant="subtle"
                                color="gray"
                                type="button"
                                onClick={() => {
                                  setThreadReplyBoxOpen(false);
                                  setReplyText("");
                                  setThreadReplyImages([]);
                                  setReplyError(null);
                                  setThreadWhisper(false);
                                }}
                              >
                                キャンセル
                              </Button>
                              <Group gap="xs">
                                <Button
                                  size="xs"
                                  color="blue"
                                  variant="light"
                                  type="button"
                                  loading={replying === 'whisper'}
                                  disabled={(replyText.trim() === "" && threadReplyImages.length === 0) || replying !== false}
                                  onClick={() => submitThreadReply(true)}
                                >
                                  ささやく
                                </Button>
                                <Button
                                  size="xs"
                                  color="green"
                                  loading={replying === 'comment'}
                                  disabled={(!replyText.trim() && threadReplyImages.length === 0) || replying !== false}
                                  type="submit"
                                >
                                  返信する
                                </Button>
                              </Group>
                            </Group>
                          </form>
                        </Paper>
                    </>
                  )}
                </Stack>
              ) : (
                <>
                <TimelineFeed
                  groups={groupFeed(feedPosts)}
                  auth={auth}
                  avatarSrc={avatarSrc}
                  mentionMembers={mentionMembers}
                  searchQuery={searchActive ? searchQuery : undefined}
                  inlineReplyFor={inlineReplyFor}
                  inlineReplyText={inlineReplyText}
                  inlineWhisper={inlineWhisper}
                  inlineReplyImages={inlineReplyImages}
                  inlineUploading={inlineUploading}
                  inlineReplying={inlineReplying}
                  onInlineReplyChange={setInlineReplyText}
                  onToggleInlineReply={toggleInlineReply}
                  onInlineReplySubmit={submitInlineReply}
                  onInlineReplyPick={onInlineReplyPick}
                  onRemoveInlineReplyImage={removeInlineReplyImage}
                  onOpenThread={openThread}
                  onOpenThreadReply={openThreadReply}
                  onLike={handleLike}
                  onReply={openThreadReply}
                  onWhisper={toggleWhisper}
                  onEdit={openEdit}
                  onDelete={setDeleteTarget}
                  onPin={handlePin}
                  onPreview={setPreviewImage}
                />
                {/* Infinite scroll sentinel + load-more fallback */}
                {feedHasMore && feedPosts.length > 0 ? (
                  <Box mt="sm" ref={feedSentinelRef} style={{ minHeight: 1 }}>
                    {feedLoadingMore ? (
                      <Text size="sm" c="dimmed" ta="center">
                        過去の投稿を読み込み中…
                      </Text>
                    ) : (
                      <Button
                        variant="subtle"
                        color="gray"
                        size="xs"
                        fullWidth
                        onClick={loadMoreFeed}
                        rightSection={<span style={{ fontSize: 12 }}>↓</span>}
                      >
                        過去の投稿を読み込む
                      </Button>
                    )}
                  </Box>
                ) : feedPosts.length > 0 ? (
                  <Text size="sm" c="dimmed" ta="center" mt="md">
                    これより古い投稿はありません
                  </Text>
                ) : null}
                </>
              )}
            </Stack>
          )}

          {activeNav === "drinews" && (
            <Stack gap="md">
              {/* ---- Dori News: list | editor | detail ---- */}
              {dnEditing ? (
                /* ---------- Editor (drikin only) ---------- */
                <Paper p="md" radius="md" withBorder shadow="sm">
                  <Group justify="space-between" align="center" mb="sm">
                    <Text fw={700} size="lg" c="inherit">
                      {dnEditing.id ? "ドリニュース編集" : "新規ドリニュース"}
                    </Text>
                    <Button variant="subtle" size="xs" color="gray" onClick={dnCloseEditor}>
                      ← 一覧へ戻る
                    </Button>
                  </Group>
                  <TextInput
                    label="タイトル"
                    placeholder="ドリニュースのタイトル"
                    value={dnEditorTitle}
                    onChange={(e) => setDnEditorTitle(e.currentTarget.value)}
                    mb="sm"
                  />
                  {/* Header image attachment */}
                  <Box mb="sm">
                    <Text size="sm" fw={500} mb={4}>ヘッダー画像</Text>
                    {dnEditorHeaderImage ? (
                      <Group align="flex-start" gap="sm">
                        <Box
                          style={{
                            position: "relative",
                            borderRadius: 8,
                            overflow: "hidden",
                            border: "1px solid var(--border-default)",
                            maxWidth: 320,
                          }}
                        >
                          <img
                            src={dnEditorHeaderImage}
                            alt="ヘッダー画像"
                            style={{ display: "block", width: "100%", height: "auto" }}
                          />
                        </Box>
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          onClick={() => setDnEditorHeaderImage(null)}
                        >
                          画像を削除
                        </Button>
                      </Group>
                    ) : (
                      <Group gap="sm">
                        <label>
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp,image/gif"
                            style={{ display: "none" }}
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) dnUploadHeaderImage(f);
                              e.target.value = "";
                            }}
                          />
                          <Button
                            component="span"
                            size="xs"
                            variant="light"
                            color="gray"
                            loading={dnUploadingHeader}
                            disabled={dnUploadingHeader}
                          >
                            🖼 画像を添付
                          </Button>
                        </label>
                        <Text size="xs" c="dimmed">
                          記事の先頭に表示されます（長辺2,048pxにリサイズ）
                        </Text>
                      </Group>
                    )}
                  </Box>
                  <Textarea
                    label="本文（マークダウン）"
                    placeholder="今日のドリニュース…（通勤電車でサクッと読める 2,000字 前後が目安 / 上限 5,000字）"
                    autosize
                    minRows={14}
                    maxRows={28}
                    maxLength={5000}
                    value={dnEditorMd}
                    onChange={(e) => setDnEditorMd(e.currentTarget.value)}
                    mb={4}
                    description={
                      <Text
                        component="span"
                        size="xs"
                        c={dnEditorMd.length > 2000 ? "orange" : "dimmed"}
                      >
                        {dnEditorMd.length} 字 / 目安 2,000字{dnEditorMd.length > 2000 ? "（やや長め）" : ""}
                      </Text>
                    }
                  />
                  <Text size="xs" c="dimmed" mb="sm">
                    #見出し / **太字** / - リスト / &gt;引用 / [リンク](URL) が使えます
                  </Text>
                  <Divider label="プレビュー" labelPosition="left" mb="sm" />
                  <div
                    className="drinews-body"
                    style={{ lineHeight: 1.8, wordBreak: "break-word" }}
                    dangerouslySetInnerHTML={{ __html: mdToHtml(dnEditorMd) }}
                  />
                  {dnError && (
                    <Text size="sm" mt="sm" c="green">
                      {dnError}
                    </Text>
                  )}
                  <Group mt="md">
                    <Button
                      size="sm"
                      color="violet"
                      variant="light"
                      onClick={dnProofread}
                      loading={dnProofreading}
                      disabled={dnProofreading || !dnEditorMd.trim()}
                    >
                      ✨ AI校正
                    </Button>
                    <Button size="sm" color="green" onClick={dnSaveDraft} loading={dnSaving} disabled={dnSaving}>
                      下書き保存
                    </Button>
                    {dnEditing.id ? (
                      <>
                        <Button size="sm" color="teal" variant="light" onClick={() => dnSchedule18(dnEditing!.id)}>
                          🕒 18:00に公開予約
                        </Button>
                        <Button size="sm" color="green" variant="filled" onClick={() => dnPublish(dnEditing!.id)}>
                          今すぐ公開
                        </Button>
                      </>
                    ) : (
                      <Text size="xs" c="dimmed">
                        下書きを保存してから予約・公開できます
                      </Text>
                    )}
                  </Group>
                </Paper>
              ) : dnSelected ? (
                /* ---------- Article detail + comments ---------- */
                <Paper p="md" radius="md" withBorder shadow="sm">
                  <Button variant="subtle" size="xs" color="gray" onClick={dnCloseView} mb="xs">
                    ← 一覧へ戻る
                  </Button>
                  <Title order={2} c="inherit" mb={4}>
                    {dnSelected.title || "（無題）"}
                  </Title>
                  <Text size="xs" c="dimmed" mb="sm">
                    {dnSelected.status === "published"
                      ? `公開: ${formatJSTPDT(dnSelected.publishedAt || dnSelected.createdAt)}`
                      : dnSelected.scheduledAt
                      ? `公開予約: ${formatJSTPDT(dnSelected.scheduledAt)}`
                      : "下書き"}
                  </Text>
                  {dnSelected.headerImage && (
                    <img
                      src={dnSelected.headerImage}
                      alt=""
                      style={{
                        width: "100%",
                        height: "auto",
                        borderRadius: 8,
                        marginBottom: 16,
                        display: "block",
                      }}
                    />
                  )}
                  <div
                    className="drinews-body"
                    style={{ lineHeight: 1.8, wordBreak: "break-word" }}
                    dangerouslySetInnerHTML={{ __html: dnSelected.bodyHtml }}
                  />
                  {/* drikin extra actions */}
                  {dnIsDrikin && (
                    <Group mt="md" gap="xs">
                      {dnSelected.status === "published" ? (
                        <>
                          <Button size="xs" variant="light" color="teal" onClick={() => dnSendEmail(dnSelected!.id)}>
                            📧 メール配信
                          </Button>
                          <Button size="xs" variant="light" color="orange" onClick={() => dnUnpublish(dnSelected!.id)}>
                            ↓ 下書きに戻す
                          </Button>
                          <Button size="xs" variant="light" color="red" onClick={() => dnDeleteArticle(dnSelected!.id)}>
                            🗑 削除
                          </Button>
                        </>
                      ) : (
                        <Button size="xs" variant="light" color="gray" onClick={() => dnStartEdit(dnSelected!)}>
                          ✏️ 編集
                        </Button>
                      )}
                    </Group>
                  )}
                  <Divider label={`コメント（${dnComments.length}）`} labelPosition="left" my="md" />
                  {dnComments.length === 0 && (
                    <Text size="sm" c="dimmed" mb="sm">
                      まだコメントがありません。
                    </Text>
                  )}
                  {dnComments.map((c) => (
                    <Box key={c.id} mb="sm">
                      <Group align="center" gap="xs" mb={2}>
                        <SafeAvatar
                          src={c.authorAvatar}
                          initial={c.authorName || c.authorEmail}
                          size="sm"
                        />
                        <Text size="xs" fw={600} c="inherit">
                          {c.authorName || c.authorEmail}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {formatJSTPDT(c.createdAt)}
                        </Text>
                        {(auth.email === c.authorEmail || dnIsDrikin) && (
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="red"
                            ml="auto"
                            aria-label="コメントを削除"
                            onClick={() => dnDeleteComment(c.id)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                            </svg>
                          </ActionIcon>
                        )}
                      </Group>
                      <Text size="sm" c="inherit" style={{ wordBreak: "break-word" }}>
                        {c.comment}
                      </Text>
                    </Box>
                  ))}
                  <Paper p="sm" radius="md" withBorder mt="sm">
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        dnSubmitComment();
                      }}
                    >
                      <Textarea
                        placeholder="コメントを書く…"
                        autosize
                        minRows={2}
                        value={dnCommentText}
                        onChange={(e) => setDnCommentText(e.currentTarget.value)}
                        mb="sm"
                      />
                      <Group justify="flex-end">
                        <Button
                          type="submit"
                          size="sm"
                          color="green"
                          loading={dnPostingComment}
                          disabled={!dnCommentText.trim()}
                        >
                          コメントする
                        </Button>
                      </Group>
                    </form>
                  </Paper>
                </Paper>
              ) : (
                /* ---------- Article list ---------- */
                <>
                  <Group justify="space-between" align="center">
                    <Title order={3} c="inherit">
                      📮 ドリニュース
                    </Title>
                    {dnIsDrikin && (
                      <Button size="sm" color="green" onClick={dnStartNew} leftSection={<span style={{ fontSize: 16 }}>＋</span>}>
                        新規作成
                      </Button>
                    )}
                  </Group>
                  {dnError && (
                    <Text size="sm" c="red">
                      {dnError}
                    </Text>
                  )}
                  {dnLoading ? (
                    <Text c="dimmed">読み込み中…</Text>
                  ) : dnArticles.length === 0 ? (
                    <Text c="dimmed">まだドリニュースがありません。</Text>
                  ) : (
                    dnArticles.map((a) => (
                      <Paper
                        key={a.id}
                        p="md"
                        radius="md"
                        withBorder
                        shadow="sm"
                        style={{ cursor: "pointer" }}
                        onClick={() => openDrinews(a.id)}
                      >
                        <Group justify="space-between" align="flex-start">
                          <Box style={{ flex: 1, minWidth: 0 }}>
                            <Text fw={600} size="md" c="inherit">
                              {a.title || "（無題）"}
                            </Text>
                            <Text size="xs" c="dimmed" mt={2}>
                              {a.status === "published"
                                ? `公開: ${formatJSTPDT(a.publishedAt || a.createdAt)}`
                                : a.scheduledAt
                                ? `公開予約: ${formatJSTPDT(a.scheduledAt)}`
                                : "下書き"}
                            </Text>
                            <Text size="xs" c="dimmed" mt={2} lineClamp={2}>
                              {a.bodyMd.replace(/[#>*`[\]]/g, "").slice(0, 120)}
                            </Text>
                          </Box>
                          <Stack gap={6} align="flex-end" style={{ flexShrink: 0 }}>
                            <Badge size="sm" color={a.status === "published" ? "green" : "gray"}>
                              {a.status === "published" ? "公開中" : "下書き"}
                            </Badge>
                            <Text size="xs" c="dimmed">
                              💬 {a.commentCount}
                            </Text>
                            {dnIsDrikin && a.status === "draft" && (
                              <Button
                                size="xs"
                                variant="light"
                                color="gray"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  dnStartEdit(a);
                                }}
                              >
                                編集
                              </Button>
                            )}
                          </Stack>
                        </Group>
                      </Paper>
                    ))
                  )}
                </>
              )}
            </Stack>
          )}
        </div>
      </AppShell.Main>

      {/* Full-screen image lightbox */}
      {previewImage && (
        <div
          onClick={() => setPreviewImage(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.94)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "zoom-out",
            padding: 0,
            margin: 0,
          }}
        >
          {/* Close button */}
          <div
            onClick={(e) => {
              e.stopPropagation();
              setPreviewImage(null);
            }}
            style={{
              position: "fixed",
              top: 16,
              right: 16,
              zIndex: 10000,
              width: 44,
              height: 44,
              borderRadius: "50%",
              background: "rgba(255,255,255,0.15)",
              color: "var(--bg-surface)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 28,
              lineHeight: 1,
              cursor: "pointer",
              userSelect: "none",
              boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
            }}
            role="button"
            aria-label="閉じる"
          >
            ✕
          </div>
          <img
            src={previewImage}
            alt="プレビュー"
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "100vw",
              maxHeight: "100vh",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              display: "block",
            }}
          />
        </div>
      )}

      {/* Edit post modal */}
      <Modal
        opened={!!editingPost}
        onClose={() => setEditingPost(null)}
        centered={!kbOpen}
        withCloseButton
        title="投稿を編集"
        styles={
          kbOpen
            ? {
                content: { marginTop: "6vh" },
              }
            : undefined
        }
      >
        {editingPost && (
          <Stack gap="sm">
            <MentionTextarea
              autosize
              minRows={3}
              placeholder="本文"
              value={editText}
              onChange={setEditText}
            />
            {editImages.length > 0 && (
              <Group gap="xs">
                {editImages.map((src, i) => (
                  <Box key={i} style={{ position: "relative" }}>
                    <Image
                      src={src}
                      width={60}
                      height={60}
                      fit="contain"
                      radius="md"
                      onClick={() => setPreviewImage(src)}
                      style={{ cursor: "pointer" }}
                    />
                    <ActionIcon
                      size="sm"
                      variant="filled"
                      color="red"
                      radius="xl"
                      style={{ position: "absolute", top: -6, right: -6 }}
                      onClick={() => setEditImages((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      ×
                    </ActionIcon>
                  </Box>
                ))}
              </Group>
            )}
            <Group justify="space-between">
              <Button
                size="xs"
                variant="light"
                color="gray"
                disabled={editImages.length >= 5}
                onClick={() => editFileRef.current?.click()}
              >
                📷 {editImages.length}/5
              </Button>
              <input
                ref={editFileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(e) => {
                  onEditPickImages(e.target.files);
                  e.target.value = "";
                }}
              />
            </Group>
            {actionError && (
              <Text size="sm" c="red">
                {actionError}
              </Text>
            )}
            <Group justify="flex-end">
              <Button variant="default" size="xs" onClick={() => setEditingPost(null)}>
                キャンセル
              </Button>
              <Button size="xs" color="green" loading={savingEdit} onClick={saveEdit}>
                保存
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        opened={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        centered
        withCloseButton
        title="投稿を削除"
      >
        <Text size="sm" c="inherit" mb="md">
          この投稿を削除しますか？この操作は取り消せません。
        </Text>
        {actionError && (
          <Text size="sm" c="red" mb="sm">
            {actionError}
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" size="xs" onClick={() => setDeleteTarget(null)}>
            キャンセル
          </Button>
          <Button size="xs" color="red" loading={deleting} onClick={confirmDelete}>
            削除する
          </Button>
        </Group>
      </Modal>

      {/* External-link menu add/edit modal (admin only) */}
      <Modal
        opened={linkModal.open}
        onClose={() => setLinkModal((m) => ({ ...m, open: false }))}
        centered
        withCloseButton
        title={linkModal.editingId ? "外部リンクを編集" : "外部リンクを追加"}
      >
        <Stack>
          <TextInput
            label="ラベル"
            value={linkModal.label}
            onChange={(e) =>
              setLinkModal((m) => ({ ...m, label: e.currentTarget.value }))
            }
            placeholder="例: ネタ帳"
          />
          <TextInput
            label="URL"
            value={linkModal.href}
            onChange={(e) =>
              setLinkModal((m) => ({ ...m, href: e.currentTarget.value }))
            }
            placeholder="https://..."
          />
          <TextInput
            label="アイコン（絵文字）"
            value={linkModal.icon}
            onChange={(e) =>
              setLinkModal((m) => ({ ...m, icon: e.currentTarget.value }))
            }
            placeholder="例: 🔖"
          />
          {linkError && (
            <Text size="sm" c="red">
              {linkError}
            </Text>
          )}
          <Group justify="flex-end">
            <Button
              variant="default"
              size="xs"
              onClick={() => setLinkModal((m) => ({ ...m, open: false }))}
            >
              キャンセル
            </Button>
            <Button size="xs" color="green" loading={linkSaving} onClick={saveLink}>
              保存
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Wave animation overlay — 👋 floats up from bottom-right (Insta-live style) */}
      <style>{`
        @keyframes bguruWaveFly {
          0%   { transform: translate(0, 0) scale(0.5) rotate(-8deg); opacity: 0; }
          12%  { opacity: 1; }
          100% { transform: translate(-90px, -360px) scale(1.15) rotate(8deg); opacity: 0; }
        }
        .bguru-wave {
          position: absolute;
          bottom: 0;
          animation: bguruWaveFly 2.6s ease-out forwards;
          will-change: transform, opacity;
          user-select: none;
          white-space: nowrap;
          pointer-events: none;
        }
      `}</style>
      {waves.length > 0 && (
        <div
          style={{
            position: "fixed",
            right: 24,
            bottom: 20,
            zIndex: 3000,
            pointerEvents: "none",
          }}
        >
          {waves.map((w, i) => (
            <div
              key={w.id}
              className="bguru-wave"
              style={{ right: (i % 5) * 16, transformOrigin: "bottom center" }}
            >
              <div style={{ fontSize: 44, lineHeight: 1, textAlign: "center" }}>👋</div>
              {w.kind === "received" && w.fromName && (
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: "var(--text-primary)",
                    background: "rgba(255,255,255,0.85)",
                    borderRadius: 8,
                    padding: "2px 6px",
                    textAlign: "center",
                    marginTop: 2,
                    display: "inline-block",
                  }}
                >
                  {w.fromName}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </AppShell>
  );
}
