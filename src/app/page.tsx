"use client";

import { Fragment, memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  Switch,
  ThemeIcon,
  Box,
  Image,
  Modal,
  ActionIcon,
  Burger,
  Popover,
  Loader,
  Tooltip,
  Menu,
  UnstyledButton,
  Collapse,
  useMantineColorScheme,
} from "@mantine/core";
import { mdToHtml } from "@/lib/md";
import type { Profile as ProfileData } from "@/lib/profile";
import {
  FeedPost,
  FeedGroup,
  jstDateKey,
  groupFeed,
  appendReplyLocal,
  parentInFeed,
  replaceReplyInFeed,
  removeReplyTemp,
  mergeFreshFeed,
} from "@/lib/feed";
import type { ChatMessage } from "@/lib/chat";

type View = "login" | "otp";

/** Decode a base64url VAPID public key into a Uint8Array for pushManager.subscribe. */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const arr = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

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

/** Human label for a JST date key, e.g. "2026年8月8日 (土)". */
function jstDateLabel(dateKey: string): string {
  const [y, m, dd] = dateKey.split("-").map(Number);
  if (!y || !m || !dd) return dateKey;
  const d = new Date(Date.UTC(y, m - 1, dd));
  const wd = d.toLocaleDateString("ja-JP", { timeZone: "UTC", weekday: "short" });
  return `${y}年${m}月${dd}日 (${wd})`;
}

/** Format a human label for a JST date key (rendered between date groups).
 *  (jstDateKey / groupFeed / FeedGroup moved to @/lib/feed) */

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

/** Convert `#/user/<userId>` (or legacy `#/user/<email>`) — bare or prefixed
 *  with the site origin — into a clickable markdown link that opens the
 *  profile timeline. Without this, marked GFM turns only an `@gmail.com`
 *  part into a `mailto:` link and leaves the `#/user/` prefix as plain text
 *  (the intro link "not working"). */
function linkifyUserLinks(text: string): string {
  return String(text || "").replace(
    /(?:https?:\/\/bsm\.backspace\.fm)?\/?#\/user\/([^\s<)\]，。、]+)/g,
    (_m, token) => "[#/user/" + token + "](#/user/" + token + ")"
  );
}

/** Normalize a member/mention name for matching: lower-case and strip all
 *  whitespace (half + full-width) so `@柳家`, `@柳家三之助` and `@[柳家 三之助]`
 *  all resolve to the same member. */
const normWs = (s: string) => String(s || "").toLowerCase().replace(/[\s\u3000]/g, "");

/** True when the chat body contains an @mention token matching any of the
 *  caller's own names (used to decide whether to make the beagle bark). */
function isMentionedIn(body: string, myNames: Set<string>): boolean {
  if (!myNames || myNames.size === 0) return false;
  let hit = false;
  body.replace(/@\[([^\]]+)\]/g, (m, name) => {
    if (myNames.has(normWs(name))) hit = true;
    return m;
  });
  body.replace(/@([^\s@\[\]]+)/g, (m, name) => {
    if (myNames.has(normWs(name))) hit = true;
    return m;
  });
  return hit;
}

/** Render a chat message body with @mention tokens highlighted. Tokens that
 *  match a member get a subtle blue tint; the current user's own name (if
 *  mentioned) is emphasised in the brand blue + bold. Plain text is untouched. */
function renderChatBody(
  body: string,
  members: MentionMember[],
  myEmail: string
): React.ReactNode {
  const nameSet = new Set(members.map((m) => normWs(m.name)));
  const myNameSet = new Set(
    members.filter((m) => m.email === myEmail).map((m) => normWs(m.name))
  );
  const parts: React.ReactNode[] = [];
  const re = /(@\[[^\]]+\]|@[^\s@\[\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(body))) {
    if (m.index > last) parts.push(body.slice(last, m.index));
    const token = m[0];
    const nm = normWs(token.slice(1).replace(/^\[|\]$/g, ""));
    const isMember = nameSet.has(nm);
    const isMe = myNameSet.has(nm);
    parts.push(
      <span
        key={k++}
        style={{
          background: isMember ? "rgba(31,144,255,0.14)" : undefined,
          color: isMe ? "#1F90FF" : isMember ? "inherit" : undefined,
          fontWeight: isMe ? 700 : undefined,
          borderRadius: 4,
          padding: isMember ? "0 2px" : undefined,
        }}
      >
        {token}
      </span>
    );
    last = m.index + token.length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length ? parts : body;
}

/* ---- Beagle bark sound (SE) ----
 * The center-screen bark also plays a short recorded dog-bark sound effect via
 * Web Audio. An AudioContext is created lazily and resumed on the first user
 * interaction (browsers block audio that starts outside a user gesture), and
 * the /bark.mp3 buffer is preloaded on mount so the first bark plays at once.
 */
let barkCtx: AudioContext | null = null;
let barkBuf: AudioBuffer | null = null;

function ensureBarkCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!barkCtx) {
    const AC: typeof AudioContext | undefined =
      window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    barkCtx = new AC();
  }
  if (barkCtx.state === "suspended") barkCtx.resume().catch(() => {});
  return barkCtx;
}

async function loadBarkBuf(): Promise<void> {
  if (barkBuf || typeof window === "undefined") return;
  const ctx = ensureBarkCtx();
  if (!ctx) return;
  try {
    const r = await fetch("/bark.mp3", { cache: "no-store" });
    if (!r.ok) return;
    const ab = await r.arrayBuffer();
    barkBuf = await ctx.decodeAudioData(ab);
  } catch {
    /* ignore — the bark just stays silent if the sound can't load */
  }
}

function playBark(): void {
  const ctx = ensureBarkCtx();
  if (!ctx) return;
  if (!barkBuf) {
    loadBarkBuf(); // preload for the next bark
    return;
  }
  try {
    const src = ctx.createBufferSource();
    src.buffer = barkBuf;
    const gain = ctx.createGain();
    gain.gain.value = 0.8;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {
    /* ignore */
  }
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
// Copy-paste image support. Extracts image file(s) from a paste event and
// returns them as a FileList (built via DataTransfer so it matches
// uploadImages' signature). Returns null when there is no image in the
// clipboard, letting the browser's normal text paste proceed untouched.
function imagesFromPaste(e: React.ClipboardEvent): FileList | null {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return null;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return null;
  const dt = new DataTransfer();
  files.forEach((f) => dt.items.add(f));
  return dt.files;
}

function MentionTextarea({
  value, onChange, onKeyDown, onPaste, placeholder, autosize, minRows, maxRows, mb,
  maxLength, label, description, autoFocus, ariaLabel, suggestUp, wrapperStyle,
  initialMention,
}: {
  value: string;
  onChange: (v: string) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  autosize?: boolean;
  minRows?: number;
  maxRows?: number;
  mb?: string | number;
  maxLength?: number;
  label?: string;
  description?: React.ReactNode;
  autoFocus?: boolean;
  ariaLabel?: string;
  /** Render the suggestion popover above the input (for compact widgets like
   *  the chat composer where opening downward would be clipped). */
  suggestUp?: boolean;
  /** Extra style on the outer wrapper (e.g. flex:1 inside a Group). */
  wrapperStyle?: React.CSSProperties;
  /** When non-null, pre-open the @-suggestion for this member name and focus
   *  the textarea (used when the user clicks an online member in the chat
   *  widget so they can immediately mention that person). */
  initialMention?: string | null;
}) {
  const [members, setMembers] = useState<MentionMember[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const membersLoaded = useRef(false);

  // When a caller pre-fills a mention (e.g. clicking an online member in the
  // chat widget), open the suggestion dropdown for that person and focus the
  // input with the caret at the end — the user can immediately hit Enter/Tab
  // to insert the mention, or keep typing to filter.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!initialMention) return;
    seededRef.current = true;
    setQuery(initialMention.replace(/^\[/, ""));
    setSuggestIndex(0);
    const ta = taRef.current;
    if (ta) {
      ta.focus();
      const p = ta.value.length;
      ta.setSelectionRange(p, p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMention]);

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
    <div style={{ position: "relative", ...(wrapperStyle ? wrapperStyle : {}) }}>
      <Textarea
        ref={taRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onPaste={onPaste}
        onCompositionEnd={() => {
          // After IME commits 2-byte text (Japanese etc.), re-detect the
          // mention query from the real value — onChange may not have delivered
          // the composing text, which left the suggestion list unfiltered.
          const ta = taRef.current;
          if (ta) updateQuery(ta.value);
        }}
        aria-label={ariaLabel}
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
            top: suggestUp ? undefined : "100%",
            bottom: suggestUp ? "calc(100% + 4px)" : undefined,
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
// =====================================================================
// Auto read/unread (per-card, client-side)
// ---------------------------------------------------------------------
// A card is "unread" (subtly highlighted) when this browser has not yet
// marked it "read". Read state is persisted per browser/user in
// localStorage and judged per individual card (each root card AND each
// reply has its own id — not per group), and survives reloads via the
// persisted read-set. Any unread card that stays in the viewport for
// AUTO_READ_DWELL_MS is automatically marked read (highlight removed).
//
// Implementation is self-contained: every PostCard subscribes to the same
// module store via useSyncExternalStore, and a single shared
// IntersectionObserver watches every [data-unread-id] card so dwell-based
// auto-read works everywhere the card is rendered (feed + thread view).
// =====================================================================
const BGURU_READ_KEY = "bguru_read_posts_v2";
const BGURU_UNREAD_ON_KEY = "bguru_auto_unread_v1";
const AUTO_READ_DWELL_MS = 1000;

type ReadStore = { enabled: boolean; read: Set<number> };

function loadReadStore(): ReadStore {
  const fallback: ReadStore = { enabled: true, read: new Set<number>() };
  try {
    // Auto-unread highlight on/off (default ON, persisted).
    let enabled = true;
    try {
      const en = localStorage.getItem(BGURU_UNREAD_ON_KEY);
      if (en !== null) enabled = en === "1";
    } catch {}
    const raw = localStorage.getItem(BGURU_READ_KEY);
    if (!raw) return { enabled, read: new Set<number>() };
    const d = JSON.parse(raw);
    const read = new Set<number>(
      Array.isArray(d.read) ? d.read.filter((n: unknown) => typeof n === "number") : []
    );
    return { enabled, read };
  } catch {
    return fallback;
  }
}

let readStore: ReadStore = loadReadStore();
// Server-render/pre-render snapshot: useSyncExternalStore requires a stable
// getServerSnapshot when the component is server-rendered. The client then
// immediately hydrates with the real localStorage-backed store.
const readServerSnapshot: ReadStore = { enabled: true, read: new Set<number>() };
const readListeners = new Set<() => void>();
function persistReadStore() {
  try {
    localStorage.setItem(BGURU_READ_KEY, JSON.stringify({ read: [...readStore.read] }));
    localStorage.setItem(BGURU_UNREAD_ON_KEY, readStore.enabled ? "1" : "0");
  } catch {}
}
function subscribeRead(l: () => void) {
  readListeners.add(l);
  return () => {
    readListeners.delete(l);
  };
}
function getReadSnapshot() {
  return readStore;
}
function isReadId(id: number) {
  return readStore.read.has(id);
}
function setUnreadEnabled(v: boolean) {
  if (readStore.enabled === v) return;
  readStore = { ...readStore, enabled: v };
  persistReadStore();
  readListeners.forEach((l) => l());
}
function markReadId(id: number) {
  if (readStore.read.has(id)) return;
  readStore = { ...readStore, read: new Set(readStore.read).add(id) };
  persistReadStore();
  readListeners.forEach((l) => l());
}

// Shared IntersectionObserver: a single observer tracks every unread card and
// marks it read once it stays in the viewport for AUTO_READ_DWELL_MS.
let readObserver: IntersectionObserver | null = null;
const readDwellTimers = new Map<number, ReturnType<typeof setTimeout>>();
function readIdOf(el: Element) {
  const n = Number(el.getAttribute("data-unread-id"));
  return Number.isFinite(n) && n > 0 ? n : null;
}
function ensureReadObserver() {
  if (readObserver || typeof IntersectionObserver === "undefined") return;
  readObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = readIdOf(entry.target);
        if (id === null) continue;
        if (entry.isIntersecting) {
          if (isReadId(id) || readDwellTimers.has(id)) continue;
          readDwellTimers.set(
            id,
            setTimeout(() => {
              readDwellTimers.delete(id);
              markReadId(id);
            }, AUTO_READ_DWELL_MS)
          );
        } else {
          const t = readDwellTimers.get(id);
          if (t) {
            clearTimeout(t);
            readDwellTimers.delete(id);
          }
        }
      }
    },
    { threshold: 0.25 }
  );
}
function observeUnreadCard(el: HTMLElement | null) {
  ensureReadObserver();
  if (!el || !readObserver) return;
  if (!readStore.enabled) return;
  const id = readIdOf(el);
  if (id === null || isReadId(id)) return;
  readObserver.observe(el);
}

// ---- Header logo "NEW" badge (drikin 2026-08) ----
// Shows ONLY the live pending counter: the number of new posts/comments that
// streamed in via SSE since the page loaded (or since the logo was last tapped).
// It does NOT count the already-loaded timeline's unread items — those are
// handled by the per-post auto-read/unread markers on the cards themselves.
// Tapping the logo clears it.
let pendingNew = 0;
const pendingListeners = new Set<() => void>();
const pendingServerSnapshot = 0;
function subscribePending(l: () => void) {
  pendingListeners.add(l);
  return () => {
    pendingListeners.delete(l);
  };
}
function getPendingSnap() {
  return pendingNew;
}
function bumpPendingNew(n = 1) {
  if (!(n > 0)) return;
  pendingNew += n;
  pendingListeners.forEach((l) => l());
}
function clearPendingNew() {
  if (pendingNew === 0) return;
  pendingNew = 0;
  pendingListeners.forEach((l) => l());
}

function FeedNewBadge() {
  const pending = useSyncExternalStore(subscribePending, getPendingSnap, () => pendingServerSnapshot);
  if (pending <= 0) return null;
  const label = pending > 99 ? "99+" : String(pending);
  return (
    <span
      aria-label={`新着${pending}件`}
      style={{
        position: "absolute",
        top: -5,
        right: -7,
        minWidth: 16,
        height: 16,
        padding: "0 4px",
        background: "#fa5252",
        color: "#fff",
        borderRadius: 999,
        fontSize: 10,
        fontWeight: 700,
        lineHeight: "16px",
        textAlign: "center",
        boxShadow: "0 0 0 2px var(--bg-surface)",
        zIndex: 5,
      }}
    >
      {label}
    </span>
  );
}

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
  onOpenProfile,
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
  onPreview: (src: string, group?: string[]) => void;
  onOpenProfile?: (email: string) => void;
}) {
  const CLAMP_THRESHOLD = 500;
  const [expanded, setExpanded] = useState(false);
  const needsClamp = post.text && post.text.length > CLAMP_THRESHOLD;
  // Timeline video: click anywhere on the video area to start playback (not just
  // the native play button). Once started, native controls appear.
  const [videoPlayed, setVideoPlayed] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const startVideo = () => {
    const v = videoRef.current;
    if (!v) return;
    v.play().catch(() => {});
    setVideoPlayed(true);
  };

  // ---- Auto read/unread (self-contained per card) ----
  const readSnap = useSyncExternalStore(subscribeRead, getReadSnapshot, () => readServerSnapshot);
  const setUnreadRef = useCallback((el: HTMLElement | null) => {
    observeUnreadCard(el);
  }, []);
  // Unread = the feature is ON and this browser has not yet marked the post
  // read. Own posts are never highlighted (you just wrote them).
  const isUnread =
    readSnap.enabled &&
    post.id > 0 &&
    auth.email !== post.authorEmail &&
    !readSnap.read.has(post.id);

  return (
    <Card
      radius="md"
      withBorder
      p="md"
      shadow="sm"
      ref={setUnreadRef as unknown as React.Ref<HTMLDivElement>}
      data-unread-id={post.id}
      data-kbd-id={post.id}
      style={{
        cursor: isThreadRoot ? "default" : "pointer",
        position: "relative",
        // Unread highlight fades out smoothly the moment the card is marked read.
        backgroundColor: isUnread ? "var(--bg-unread)" : "transparent",
        transition: "background-color 0.6s ease",
      }}
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
        <UnstyledButton
          onClick={(e) => {
            e.stopPropagation();
            onOpenProfile?.(post.authorEmail);
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: "1 1 auto",
            minWidth: 0,
            textAlign: "left",
            color: "inherit",
          }}
          aria-label={`${post.authorName || post.authorEmail.split("@")[0]} のプロフィールを見る`}
        >
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
        </UnstyledButton>
      </Group>

      {post.text && (
        <div style={{ position: "relative" }}>
          <div
            className="post-body"
            dangerouslySetInnerHTML={{
              __html: highlightSearchTerm(
                mdToHtml(
                  highlightMentions(
                    linkifyUserLinks(
                      needsClamp && !expanded
                        ? post.text.slice(0, CLAMP_THRESHOLD)
                        : post.text
                    ),
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
              onClick={() => onPreview(src, post.images)}
            />
          ))}
        </Group>
      )}

      {/* Video attachment (at most one per post). Clicking anywhere on the video
       * area starts playback (not just the native play button); once playing the
       * native controls appear so the viewer can pause/seek/scrub. */}
      {post.videoUrl && (
        <Box mt="sm" style={{ position: "relative", width: "100%", maxWidth: 560 }}>
          <video
            ref={videoRef}
            src={post.videoUrl}
            playsInline
            preload="metadata"
            controls={videoPlayed}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "100%",
              display: "block",
              borderRadius: 12,
              background: "#000",
              maxHeight: 420,
            }}
          />
          {!videoPlayed && (
            <Box
              onClick={(e) => {
                e.stopPropagation();
                startVideo();
              }}
              role="button"
              aria-label="動画を再生"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
                background: "rgba(0,0,0,0.22)",
                borderRadius: 12,
              }}
            >
              <Box
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: "50%",
                  background: "rgba(0,0,0,0.7)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 20,
                  color: "#fff",
                }}
              >
                ▶
              </Box>
            </Box>
          )}
        </Box>
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
  onOpenProfile,
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
  onPreview: (src: string, group?: string[]) => void;
  onOpenProfile?: (email: string) => void;
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
            onOpenProfile={onOpenProfile}
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
              onOpenProfile={onOpenProfile}
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
          onOpenProfile={onOpenProfile}
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
  onOpenProfile,
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
  onPreview: (src: string, group?: string[]) => void;
  onOpenProfile?: (email: string) => void;
}) {
  return (
    <Box
      ml={6}
      style={{
        borderLeft: "2px solid var(--border-green-soft)",
        paddingLeft: 8,
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
        onOpenProfile={onOpenProfile}
      />
    </Box>
  );
}

/** Banner crop editor: pan the image (drag) + zoom (wheel / buttons) inside a
 *  fixed 3:1 frame, then apply → crops to the banner region and renders a
 *  resized JPEG (1600px wide) ready for upload. */
const BANNER_ASPECT = 3; // width:height of the banner display area
const BANNER_OUT_W = 1600;

function BannerCropper({
  src,
  onApply,
  onCancel,
  uploading,
}: {
  src: string;
  onApply: (blob: Blob) => void;
  onCancel: () => void;
  uploading: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const [cw, setCw] = useState(0);
  const [img, setImg] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ px: number; py: number; pan: { x: number; y: number } } | null>(null);

  const ch = Math.round(cw / BANNER_ASPECT);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setCw(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const im = new window.Image();
    im.onload = () => setImg({ w: im.naturalWidth, h: im.naturalHeight });
    im.src = src;
  }, [src]);

  // base cover scale (image must cover the frame), multiplied by user zoom.
  const base = img && cw ? Math.max(cw / img.w, ch / img.h) : 0;
  const s = base * zoom;
  const dispW = img ? img.w * s : 0;
  const dispH = img ? img.h * s : 0;
  const minX = Math.min(0, cw - dispW);
  const minY = Math.min(0, ch - dispH);
  const ox = Math.min(0, Math.max(minX, pan.x));
  const oy = Math.min(0, Math.max(minY, pan.y));

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(6, Math.max(1, Number((z - e.deltaY * 0.001).toFixed(2)))));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!(e.target as HTMLElement).setPointerCapture) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { px: e.clientX, py: e.clientY, pan: { x: ox, y: oy } };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPan({
      x: dragRef.current.pan.x + (e.clientX - dragRef.current.px),
      y: dragRef.current.pan.y + (e.clientY - dragRef.current.py),
    });
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  const apply = () => {
    const el = imgRef.current;
    if (!img || !cw || !el) return;
    const outH = Math.round(BANNER_OUT_W / BANNER_ASPECT);
    const canvas = document.createElement("canvas");
    canvas.width = BANNER_OUT_W;
    canvas.height = outH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    // Visible region in intrinsic image coords (container origin maps to -ox,-oy).
    const sx = -ox / s;
    const sy = -oy / s;
    const sw = cw / s;
    const sh = ch / s;
    ctx.drawImage(el, sx, sy, sw, sh, 0, 0, BANNER_OUT_W, outH);
    canvas.toBlob(
      (b) => {
        if (b) onApply(b);
      },
      "image/jpeg",
      0.85
    );
  };

  return (
    <div>
      <Box
        ref={wrapRef}
        style={{
          width: "100%",
          aspectRatio: `${BANNER_ASPECT}/1`,
          overflow: "hidden",
          position: "relative",
          cursor: "grab",
          touchAction: "none",
          background: "#e8ecef",
          borderRadius: 8,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onWheel={onWheel}
      >
        {img ? (
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            style={{
              position: "absolute",
              left: ox,
              top: oy,
              width: dispW,
              height: dispH,
              maxWidth: "none",
              userSelect: "none",
            }}
          />
        ) : (
          <Text size="sm" c="dimmed" style={{ padding: 12 }}>
            読み込み中…
          </Text>
        )}
      </Box>
      <Group justify="space-between" mt="xs">
        <Group gap="xs">
          <Button size="xs" variant="light" color="gray" onClick={() => setZoom((z) => Math.min(6, z + 0.25))}>
            拡大
          </Button>
          <Button size="xs" variant="light" color="gray" onClick={() => setZoom((z) => Math.max(1, z - 0.25))}>
            縮小
          </Button>
          <Text size="xs" c="dimmed">
            ドラッグで位置調整・ホイールでズーム
          </Text>
        </Group>
        <Group gap="xs">
          <Button size="xs" variant="subtle" color="gray" onClick={onCancel} disabled={uploading}>
            キャンセル
          </Button>
          <Button size="xs" color="green" onClick={apply} loading={uploading} disabled={uploading}>
            この範囲で設定
          </Button>
        </Group>
      </Group>
    </div>
  );
}

/** X-style profile timeline view: profile header card + the user's post cards. */
function ProfileView({
  profile,
  posts,
  loading,
  hasMore,
  isOwn,
  auth,
  avatarSrc,
  mentionMembers,
  searchQuery,
  onClose,
  onLoadMore,
  onEdit,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onWhisper,
  onEditPost,
  onDelete,
  onPin,
  onPreview,
  onOpenProfile,
}: {
  profile: ProfileData | null;
  posts: FeedPost[];
  loading: boolean;
  hasMore: boolean;
  isOwn: boolean;
  auth: { email: string };
  avatarSrc?: string | null;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  onClose: () => void;
  onLoadMore: () => void;
  onEdit: () => void;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number, name: string) => void;
  onWhisper?: (id: number, name: string) => void;
  onEditPost: (post: FeedPost) => void;
  onDelete: (post: FeedPost) => void;
  onPin: (id: number) => void;
  onPreview: (src: string, group?: string[]) => void;
  onOpenProfile?: (email: string) => void;
}) {
  return (
    <Stack gap="md">
      <Button
        variant="subtle"
        size="xs"
        onClick={onClose}
        leftSection={<span style={{ fontSize: 12 }}>←</span>}
        mb="xs"
        color="gray"
      >
        タイムラインに戻る
      </Button>

      {/* Profile header card (X-style) */}
      <Paper radius="md" withBorder p={0} style={{ overflow: "hidden" }}>
        <Box
          style={{
            height: 140,
            background: profile?.headerImage
              ? `url(${profile.headerImage}) center / cover`
              : "linear-gradient(135deg, #e2f4e2, #cfe8cf)",
          }}
        />
        <Box px="md" style={{ marginTop: -30, position: "relative" }}>
          <SafeAvatar
            src={profile?.avatar || undefined}
            initial={profile?.name || "?"}
            size="lg"
          />
          {isOwn && (
            <Button
              size="xs"
              variant="light"
              color="green"
              style={{ position: "absolute", right: 12, top: 6 }}
              onClick={onEdit}
            >
              プロフィールを編集
            </Button>
          )}
        </Box>
        <Box px="md" pb="md" style={{ marginTop: 8 }}>
          <Text fw={700} size="lg">
            {profile?.name || "?"}
          </Text>
          {profile?.bio ? (
            <div
              className="post-body"
              dangerouslySetInnerHTML={{ __html: mdToHtml(profile.bio) }}
              style={{ marginTop: 8 }}
            />
          ) : null}
          {profile && profile.postCount > 0 ? (
            <Text size="sm" c="dimmed" mt={6}>
              {profile.postCount}件の投稿
            </Text>
          ) : null}
          {profile && profile.links && profile.links.length > 0 ? (
            <Group gap="md" mt={8} wrap="wrap">
              {profile.links.map((l, i) => (
                <a
                  key={i}
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    // Never let a same-origin / hash reference link navigate the
                    // current page (especially back into this SPA's #/user URL,
                    // which would reload → "Page cannot be loaded"). Cross-origin
                    // links still open in a new tab.
                    try {
                      const target = new URL(l.href, window.location.origin);
                      if (target.origin === window.location.origin) e.preventDefault();
                    } catch {
                      e.preventDefault();
                    }
                  }}
                  style={{
                    fontSize: 13,
                    color: "var(--text-green)",
                    textDecoration: "none",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <path d="M15 3h6v6" />
                    <path d="M10 14 21 3" />
                  </svg>
                  {l.label || l.href}
                </a>
              ))}
            </Group>
          ) : null}
        </Box>
      </Paper>

      {/* The user's post cards (profile timeline) */}
      {loading && posts.length === 0 ? (
        <Text c="dimmed">読み込み中…</Text>
      ) : posts.length === 0 ? (
        <Text c="dimmed">まだ投稿がありません。</Text>
      ) : (
        <>
          {groupFeed(posts).map((g) => {
            const post = g.posts[0];
            return (
              <Box
                key={`${g.dateKey}|${g.authorEmail}|${post.id}`}
                data-post-id={post.id}
                style={{
                  borderLeft: "3px solid var(--border-green-soft)",
                  borderTopLeftRadius: 8,
                  borderBottomLeftRadius: 8,
                  paddingLeft: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
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
                  onEdit={onEditPost}
                  onDelete={onDelete}
                  onPin={onPin}
                  onPreview={onPreview}
                  onOpenProfile={onOpenProfile}
                />
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
                  onEdit={onEditPost}
                  onDelete={onDelete}
                  onPin={onPin}
                  onPreview={onPreview}
                  onOpenProfile={onOpenProfile}
                />
              </Box>
            );
          })}
          {hasMore ? (
            <Button
              variant="subtle"
              color="gray"
              size="xs"
              fullWidth
              onClick={onLoadMore}
              rightSection={<span style={{ fontSize: 12 }}>↓</span>}
            >
              {loading ? "読み込み中…" : "過去の投稿を読み込む"}
            </Button>
          ) : posts.length ? (
            <Text size="sm" c="dimmed" ta="center" mt="md">
              これより古い投稿はありません
            </Text>
          ) : null}
        </>
      )}
    </Stack>
  );
}
function BarkIcon({ size = 14, color = "currentColor" }: { size?: number; color?: string }) {
  return (
    <svg
      viewBox="0 0 1194 742"
      width={size}
      height={Math.round(size * (742 / 1194))}
      fill={color}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <g transform="translate(0,742) scale(0.1,-0.1)">
        <path d="M11232 7399 c-66 -21 -133 -73 -307 -239 -117 -112 -518 -485 -715 -664 -190 -174 -276 -256 -251 -241 10 6 12 4 7 -4 -5 -7 -10 -10 -13 -7 -8 8 -79 -56 -75 -67 1 -5 -2 -6 -8 -2 -14 8 -67 -79 -85 -139 -23 -77 -13 -206 16 -206 6 0 7 -4 4 -10 -3 -5 10 -35 30 -65 60 -95 193 -142 327 -115 97 19 80 7 413 295 76 66 177 154 225 195 47 41 133 116 189 165 113 99 252 219 376 325 274 234 303 267 326 379 55 267 -196 487 -459 400z" />
        <path d="M4520 7183 c-286 -22 -720 -117 -975 -214 -194 -74 -220 -86 -460 -214 -268 -143 -665 -483 -820 -703 -22 -31 -62 -86 -88 -121 -148 -199 -281 -488 -378 -820 -29 -97 -39 -116 -171 -315 -78 -116 -141 -216 -141 -223 0 -7 -4 -10 -8 -7 -6 4 -22 -28 -24 -48 0 -3 -4 -10 -9 -15 -5 -5 -6 -2 -1 6 6 10 4 12 -4 7 -7 -5 -10 -14 -7 -22 3 -7 0 -16 -6 -20 -7 -5 -8 -2 -3 7 20 34 -18 -13 -79 -100 -36 -51 -63 -98 -59 -105 3 -6 2 -8 -2 -3 -11 9 -46 -43 -38 -56 3 -6 1 -7 -4 -4 -6 4 -35 -28 -64 -71 -63 -90 -293 -396 -376 -499 -32 -39 -80 -99 -108 -134 -27 -34 -75 -92 -105 -129 -324 -395 -379 -471 -460 -635 -315 -633 -30 -1360 680 -1738 58 -31 110 -57 115 -58 6 -1 34 -13 63 -26 404 -178 1030 -186 1462 -18 977 381 1340 1263 1029 2498 -92 368 -294 944 -450 1284 -68 148 -21 225 119 197 70 -14 318 -283 442 -479 35 -55 70 -106 79 -112 8 -7 11 -13 7 -13 -5 0 -3 -6 3 -14 43 -52 229 -464 306 -677 38 -106 45 -130 75 -244 81 -310 109 -495 117 -760 23 -795 -267 -1377 -859 -1718 -26 -15 -49 -35 -53 -46 -8 -25 12 -74 27 -65 6 4 8 3 4 -4 -7 -12 140 -150 233 -218 384 -279 881 -478 1309 -524 240 -26 317 22 434 271 98 209 373 717 452 836 282 423 536 627 982 787 205 73 512 133 1219 236 777 114 1008 196 1118 397 54 101 74 273 36 319 -6 8 -9 14 -5 14 11 0 -35 83 -70 126 -47 58 -149 108 -301 149 -70 18 -204 53 -298 78 -822 217 -995 292 -1070 462 -91 204 22 354 425 562 199 103 765 391 895 455 503 249 711 510 732 920 16 296 -96 592 -302 806 l-55 56 16 54 c95 327 -155 633 -517 632 -215 -1 -358 -69 -559 -266 -157 -154 -191 -173 -592 -339 -64 -27 -114 -53 -111 -58 3 -6 1 -7 -5 -3 -6 4 -82 -21 -169 -55 -369 -144 -315 -139 -399 -36 -454 556 -1257 841 -2174 770z m1200 -1183 c251 -85 433 -499 291 -661 -7 -8 -30 -42 -53 -77 -47 -74 -142 -154 -210 -179 -27 -10 -48 -21 -48 -25 0 -4 -7 -4 -17 -1 -10 4 -14 2 -10 -4 4 -6 -3 -8 -20 -5 -16 3 -24 1 -20 -5 8 -12 -110 -7 -189 8 -216 41 -379 234 -392 462 -2 48 -9 87 -14 87 -5 0 -2 7 7 16 9 10 14 26 11 36 -2 11 -2 17 1 14 3 -3 16 19 29 50 102 252 372 372 634 284z m-683 -432 c-3 -8 -6 -5 -6 6 -1 11 2 17 5 13 3 -3 4 -12 1 -19z" />
        <path d="M11035 4669 c-1184 -17 -1073 -13 -1138 -38 -261 -101 -288 -460 -45 -592 l63 -34 590 4 c1011 6 1179 12 1245 42 320 149 200 648 -150 627 -14 -1 -268 -5 -565 -9z" />
        <path d="M9750 3406 c-158 -46 -235 -147 -235 -311 0 -168 24 -202 296 -410 113 -86 301 -234 643 -505 475 -377 521 -401 689 -357 343 90 382 467 72 685 -29 20 -99 71 -155 112 -55 41 -129 95 -164 120 -35 25 -126 92 -203 150 -77 58 -160 119 -184 136 -24 17 -141 103 -260 191 -272 201 -353 232 -499 189z" />
      </g>
    </svg>
  );
}

// Self-contained inline "insert between cards" comment box. Owns its own
// text/image/upload/posting state so TYPING HERE does NOT re-render the whole
// timeline. This is the same isolation that was already applied to the main
// composer (ComposerPaper) but was still missing for the inline reply box — the
// reply text used to live at the page root, so every keystroke re-rendered all
// ~500 cards (the "text input feels slow" report). Mirror of ComposerPaper.
function InlineReplyBox({
  postId,
  authorLabel,
  uploadImages,
  uploadVideo,
  onSubmit,
  onCancel,
  onPreview,
}: {
  postId: number;
  authorLabel: string;
  uploadImages: (
    files: FileList | null,
    current: string[],
    setter: (fn: (prev: string[]) => string[]) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void
  ) => Promise<void>;
  uploadVideo: (
    files: FileList | null,
    setUrl: (v: string) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void,
    clearPrev?: () => void
  ) => Promise<void>;
  onSubmit: (
    id: number,
    text: string,
    images: string[],
    whisper: boolean,
    videoUrl?: string | null
  ) => Promise<void>;
  onCancel: () => void;
  onPreview: (src: string, group?: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState<"comment" | "whisper" | false>(false);
  const [error, setError] = useState<string | null>(null);
  // At most one video attachment.
  const [video, setVideo] = useState<string | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);

  const canSend = (text.trim() !== "" || images.length > 0 || !!video) && posting === false;

  const onPick = (files: FileList | null) =>
    uploadImages(files, images, setImages, setUploading, (s) => setError(s));
  // Copy-paste image attachment: route clipboard images through the same
  // upload flow as the 📷 picker (respecting the 5-image cap in uploadImages).
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imagesFromPaste(e);
    if (files) {
      e.preventDefault();
      onPick(files);
    }
  };
  const removeImage = (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i));
  const onPickVideo = (files: FileList | null) =>
    uploadVideo(files, setVideo, setVideoUploading, (s) => setError(s));
  const removeVideo = () => setVideo(null);

  const handleSubmit = async (whisper: boolean) => {
    if (!canSend) return;
    const t = text;
    const imgs = images;
    const v = video;
    setPosting(whisper ? "whisper" : "comment");
    setError(null);
    try {
      await onSubmit(postId, t, imgs, whisper, v);
    } catch (err: any) {
      setError(err?.message || "コメントに失敗しました");
    } finally {
      setPosting(false);
    }
  };

  return (
    <Stack
      gap={6}
      p="xs"
      style={{ background: "var(--bg-subtle)", borderRadius: 8, border: "1px solid var(--border-green-soft)" }}
    >
      <Text size="xs" c="dimmed">
        この位置にコメントします
      </Text>
      <MentionTextarea
        value={text}
        autoFocus
        onChange={setText}
        onPaste={handlePaste}
        placeholder={`${authorLabel} の投稿にコメント…（Shift+Enter でうなる）`}
        minRows={2}
        autosize
        maxRows={5}
        onKeyDown={(e) => {
          if ((e.nativeEvent as any).isComposing) return;
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            handleSubmit(false);
          } else if (e.shiftKey && e.key === "Enter") {
            e.preventDefault();
            handleSubmit(true);
          }
        }}
      />
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
      {/* Comment image attachments (same as main post) */}
      {images.length > 0 && (
        <Group gap="xs" mb={4}>
          {images.map((src, i) => (
            <Box key={i} style={{ position: "relative" }}>
              <Image
                src={src}
                width={56}
                height={56}
                fit="contain"
                radius="md"
                style={{ cursor: "pointer" }}
                onClick={() => onPreview(src, images)}
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
      {/* Comment video attachment (at most one; shown inline) */}
      {video && (
        <Box mb={4} style={{ position: "relative", width: "100%", maxWidth: 320 }}>
          <video
            src={video}
            controls
            playsInline
            preload="metadata"
            style={{ width: "100%", display: "block", borderRadius: 8, background: "#000" }}
          />
          <ActionIcon
            size="sm"
            variant="filled"
            color="red"
            radius="xl"
            style={{ position: "absolute", top: -6, right: -6 }}
            onClick={removeVideo}
          >
            ×
          </ActionIcon>
        </Box>
      )}
      <Group gap="xs" mb={4}>
        <label style={{ cursor: "pointer", display: "inline-block" }}>
          <input
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              onPick(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            size="xs"
            variant="light"
            color="gray"
            component="span"
            loading={uploading}
            disabled={images.length >= 5}
          >
            📷 {images.length}/5
          </Button>
        </label>
        <label style={{ cursor: "pointer", display: "inline-block" }}>
          <input
            type="file"
            accept="video/mp4,video/webm,video/quicktime"
            hidden
            onChange={(e) => {
              onPickVideo(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            size="xs"
            variant="light"
            color="gray"
            component="span"
            loading={videoUploading}
            disabled={!!video}
          >
            🎬 動画
          </Button>
        </label>
      </Group>
      <Group justify="space-between" align="center" gap="xs">
        <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
          キャンセル
        </Button>
        <Group gap="xs">
          <Button
            size="xs"
            color="blue"
            variant="light"
            loading={posting === "whisper"}
            disabled={!canSend}
            onClick={() => handleSubmit(true)}
          >
            うなる
          </Button>
          <Button
            size="xs"
            loading={posting === "comment"}
            disabled={!canSend}
            onClick={() => handleSubmit(false)}
          >
            吠える
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}

// 検索窓を self-contained(無 hooks 問題なし): ローカルstate で入力中はページ再レンダリングさせない。
const SearchBox = memo(function SearchBox({
  value,
  onCommit,
  onClear,
}: {
  value: string;
  onCommit: (q: string) => void;
  onClear: () => void;
}) {
  const [text, setText] = useState(value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedRef = useRef(value);
  // 外部からの変更（トレンドtap・ナビ切替で parent が setSearchQuery した場合）を表示に反映
  useEffect(() => {
    if (value !== lastCommittedRef.current) {
      lastCommittedRef.current = value;
      setText(value);
    }
  }, [value]);
  const handleChange = (v: string) => {
    setText(v);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      lastCommittedRef.current = v.trim();
      onCommit(v.trim());
    }, 300);
  };
  const handleClear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    lastCommittedRef.current = "";
    setText("");
    onClear();
  };
  return (
    <TextInput
      placeholder="タイムラインを検索"
      value={text}
      onChange={(e) => handleChange(e.currentTarget.value)}
      size="sm"
      leftSection={
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
      }
      rightSection={
        text ? (
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={handleClear} aria-label="検索をクリア">
            ×
          </ActionIcon>
        ) : null
      }
      aria-label="タイムラインを検索"
    />
  );
});

function TimelineFeed({
  groups,
  auth,
  avatarSrc,
  mentionMembers,
  searchQuery,
  inlineReplyFor,
  uploadImages,
  uploadVideo,
  onToggleInlineReply,
  onInlineReplySubmit,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onWhisper,
  onEdit,
  onDelete,
  onPin,
  onPreview,
  onOpenProfile,
  skipFirstDate,
}: {
  groups: FeedGroup[];
  auth: { email: string };
  avatarSrc?: string | null;
  mentionMembers?: MentionMember[];
  searchQuery?: string;
  inlineReplyFor: number | null;
  uploadImages: (
    files: FileList | null,
    current: string[],
    setter: (fn: (prev: string[]) => string[]) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void
  ) => Promise<void>;
  uploadVideo: (
    files: FileList | null,
    setUrl: (v: string) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void,
    clearPrev?: () => void
  ) => Promise<void>;
  onToggleInlineReply: (id: number) => void;
  onInlineReplySubmit: (
    id: number,
    text: string,
    images: string[],
    whisper: boolean,
    videoUrl?: string | null
  ) => Promise<void>;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number) => void;
  onWhisper?: (id: number, name: string) => void;
  onEdit: (p: FeedPost) => void;
  onDelete: (p: FeedPost) => void;
  onPin: (id: number) => void;
  onPreview: (src: string, group?: string[]) => void;
  onOpenProfile?: (email: string) => void;
  skipFirstDate?: boolean;
}) {
  // When the parent renders the topmost date separator itself (above the
  // "+" composer), skip the first in-feed separator to avoid duplication.
  let lastDate = skipFirstDate && groups.length > 0 ? groups[0].dateKey : "";
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

    // MUST be unique per ROOT post: two groups by the same author on the same
    // day would otherwise collide on the React key (`dateKey|authorEmail`),
    // which makes React mis-reconcile siblings when a comment floats a group
    // to the top — leaving a stale copy of the ORIGINAL card group and its
    // still-open comment box behind (the "original group + posting screen
    // remain" bug). Appending the root post id makes every key unique.
    const gkey = `${g.dateKey}|${g.authorEmail}|${g.posts[0].id}`;

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
              onOpenProfile={onOpenProfile}
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
              onOpenProfile={onOpenProfile}
            />
            {/* "+" insert control: a small circular button centered in a slim row
             * between cards. Center placement is intuitive ("insert here"),
             * while the single narrow row keeps vertical space tight. */}
            {inlineReplyFor === post.id ? (
              <InlineReplyBox
                postId={post.id}
                authorLabel={g.authorName || g.authorEmail.split("@")[0]}
                uploadImages={uploadImages}
                uploadVideo={uploadVideo}
                onSubmit={onInlineReplySubmit}
                onCancel={() => onToggleInlineReply(post.id)}
                onPreview={onPreview}
              />
            ) : (
              <Box style={{ display: "flex", justifyContent: "center", lineHeight: 0 }}>
                <UnstyledButton
                  onClick={() => onToggleInlineReply(post.id)}
                  aria-label="コメントを挟み込む"
                  style={{ cursor: "pointer", padding: 2, background: "transparent", border: "none", lineHeight: 1 }}
                >
                  <Box
                    
                    className="bguru-bark-btn"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      color: "var(--text-green-soft)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <BarkIcon size={20} color="#1F90FF" />
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

// Optimistic feed mutation helpers (appendReplyLocal / parentInFeed /
// replaceReplyInFeed / removeReplyTemp) now live in @/lib/feed (pure + tested).

/**
 * Detect whether a draft contains meaningful Markdown structure (headings,
 * lists, blockquotes, code fences, bold, links). Used to auto-show a rendered
 * Markdown preview in the composer. A modest score threshold avoids false
 * positives on plain prose that merely contains a single `*` or a link.
 */
function detectMarkdown(raw: string): boolean {
  const text = raw ?? "";
  if (!text.trim()) return false;
  let score = 0;
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (/^(#{1,6})\s+\S/.test(l)) score += 2; // heading
    else if (/^```/.test(l)) score += 2; // code fence
    else if (/^(\s*[-*+]\s+\S|\s*\d+\.\s+\S)/.test(l)) score += 1; // list item
    else if (/^>\s?/.test(l)) score += 1; // blockquote
    else if (/^(:?-{3,}|\*{3,}|_{3,})\s*$/.test(l)) score += 1; // horizontal rule
    else if (/\*\*[^*\n]+\*\*/.test(line)) score += 1; // bold
    else if (/\[[^\]\n]+\]\([^\s)]+\)/.test(line)) score += 1; // link
  }
  return score >= 2;
}

// Composer rendered when the top "+" is expanded. Owns its text/image/upload/
// posting state locally so that typing (or attaching images) does NOT re-render
// the entire page (which contains the full timeline feed) on every keystroke.
function ComposerPaper({
  auth,
  avatarSrc,
  displayName,
  mentionMembers,
  uploadImages,
  uploadVideo,
  onPublish,
  onClose,
  onPreviewImage,
}: {
  auth: { name?: string | null; email: string };
  avatarSrc?: string | null;
  displayName: string;
  mentionMembers?: MentionMember[];
  uploadImages: (
    files: FileList | null,
    current: string[],
    setter: (fn: (prev: string[]) => string[]) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void
  ) => Promise<void>;
  uploadVideo: (
    files: FileList | null,
    setUrl: (v: string) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void,
    clearPrev?: () => void
  ) => Promise<void>;
  onPublish: (text: string, images: string[], videoUrl?: string | null) => Promise<void>;
  onClose: () => void;
  onPreviewImage: (src: string, group?: string[]) => void;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<string | null>(null);
  const [videoUploading, setVideoUploading] = useState(false);
  const [proofreading, setProofreading] = useState(false);
  const AI_PROOFREAD_MIN = 500; // "AI校正" button enables >500 chars
  const [previewHidden, setPreviewHidden] = useState(false);
  const isMarkdown = detectMarkdown(text); // auto-show rendered preview when markdown detected
  const showPreview = isMarkdown && !previewHidden && text.trim().length > 0;
  const charCount = text.trim().length; // matches the AI校正 enable condition (>500)
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLInputElement>(null);
  // Markdown auto-preview is DEBOUNCED: re-rendering the whole doc through
  // marked+sanitize on every keystroke heavy-handedly chokes on long text
  // (freezes / OS-kills the tab on mobile). Render only after ~250ms of idle,
  // which keeps long-input typing smooth while still auto-showing the preview.
  const [previewHtml, setPreviewHtml] = useState<string>("");
  const mentionMembersRef = useRef(mentionMembers);
  mentionMembersRef.current = mentionMembers;
  useEffect(() => {
    const want = isMarkdown && !previewHidden && text.trim().length > 0;
    if (!want) {
      setPreviewHtml("");
      return;
    }
    const t = setTimeout(() => {
      setPreviewHtml(
        mdToHtml(highlightMentions(linkifyUserLinks(text), mentionMembersRef.current ?? []))
      );
    }, 250);
    return () => clearTimeout(t);
  }, [text, isMarkdown, previewHidden]);

  const onPick = (files: FileList | null) =>
    uploadImages(files, images, setImages, setUploading, (s) => setError(s));
  // Copy-paste image attachment: route clipboard images through the same
  // upload flow as the 📷 picker (respecting the 5-image cap in uploadImages).
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imagesFromPaste(e);
    if (files) {
      e.preventDefault();
      onPick(files);
    }
  };
  const removeImage = (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i));
  const onPickVideo = (files: FileList | null) =>
    uploadVideo(files, setVideo, setVideoUploading, (s) => setError(s));
  const removeVideo = () => setVideo(null);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if ((!text.trim() && images.length === 0 && !video) || posting) return;
    const t = text;
    const imgs = images;
    const v = video;
    setPosting(true);
    setError(null);
    setText("");
    setImages([]);
    setVideo(null);
    try {
      await onPublish(t, imgs, v);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setPosting(false);
    }
  };

  // AI校正 — send the draft to /api/posts/proofread and replace the input with
  // the corrected markdown. Enabled when the text exceeds AI_PROOFREAD_MIN chars.
  const handleProofread = async () => {
    if (text.trim().length <= AI_PROOFREAD_MIN || proofreading) return;
    setError(null);
    setProofreading(true);
    try {
      const r = await fetch("/api/posts/proofread", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bodyMd: text }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d?.error || "AI校正に失敗しました");
      setText(d?.markdown ?? "");
    } catch (err: any) {
      setError(err?.message || "AI校正に失敗しました");
    } finally {
      setProofreading(false);
    }
  };

  // Cmd/Ctrl + Enter to submit (skip during IME composition)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if ((e.nativeEvent as any).isComposing) return;
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Paper p="md" radius="md" withBorder shadow="sm">
      <Group align="flex-start" gap="sm" mb="xs">
        <Avatar src={avatarSrc} alt={displayName} radius="xl" size="md" color="green">
          {displayName.charAt(0).toUpperCase()}
        </Avatar>
        <Text fw={600} size="sm" c="inherit" style={{ flex: 1 }}>
          {auth.name || auth.email}
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          radius="xl"
          size="sm"
          aria-label="投稿フォームを閉じる"
          title="閉じる"
          onClick={onClose}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </ActionIcon>
      </Group>
      <form onSubmit={handleSubmit}>
        <MentionTextarea
          placeholder="今なにしてる？ (画像・動画投稿もできます)"
          autosize
          minRows={2}
          autoFocus
          value={text}
          onChange={setText}
          onKeyDown={onKeyDown}
          onPaste={handlePaste}
          mb="xs"
        />
        <Group justify="flex-end" gap={6} mb="sm">
          <Text size="xs" c={charCount >= AI_PROOFREAD_MIN ? "indigo" : "dimmed"} style={{ fontWeight: charCount >= AI_PROOFREAD_MIN ? 600 : undefined }}>
            {charCount}文字
          </Text>
          {charCount > 0 && charCount < AI_PROOFREAD_MIN && (
            <Text size="xs" c="dimmed">
              あと{AI_PROOFREAD_MIN - charCount}文字でAI校正が使えます
            </Text>
          )}
          {charCount >= AI_PROOFREAD_MIN && (
            <Text size="xs" c="indigo" style={{ fontWeight: 600 }}>
              AI校正が使えます
            </Text>
          )}
        </Group>
        {showPreview && previewHtml && (
          <Box mb="sm" style={{ borderRadius: 8, background: "var(--bg-light, rgba(127,127,127,0.06))", padding: "0.6em 0.9em" }}>
            <Group justify="space-between" mb={4}>
              <Text size="xs" c="dimmed" style={{ fontWeight: 600 }}>
                👁 プレビュー
              </Text>
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                aria-label="プレビューを隠す"
                title="プレビューを隠す"
                onClick={() => setPreviewHidden(true)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </ActionIcon>
            </Group>
            <div
              className="post-body"
              dangerouslySetInnerHTML={{
                __html: previewHtml,
              }}
            />
          </Box>
        )}
        {images.length > 0 && (
          <Group gap="xs" mb="sm">
            {images.map((src, i) => (
              <Box key={i} style={{ position: "relative" }}>
                <Image
                  src={src}
                  width={72}
                  height={72}
                  fit="contain"
                  radius="md"
                  style={{ cursor: "pointer" }}
                  onClick={() => onPreviewImage(src, images)}
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
        {video && (
          <Box mb="sm" style={{ position: "relative", width: "100%", maxWidth: 360 }}>
            <video
              src={video}
              controls
              playsInline
              preload="metadata"
              style={{ width: "100%", display: "block", borderRadius: 8, background: "#000" }}
            />
            <ActionIcon
              size="sm"
              variant="filled"
              color="red"
              radius="xl"
              style={{ position: "absolute", top: -6, right: -6 }}
              onClick={removeVideo}
            >
              ×
            </ActionIcon>
          </Box>
        )}
        <Group justify="space-between">
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              color="gray"
              loading={uploading}
              disabled={images.length >= 5}
              onClick={() => fileRef.current?.click()}
            >
              📷 {images.length}/5
            </Button>
            <Button
              size="xs"
              variant="light"
              color="gray"
              loading={videoUploading}
              disabled={!!video}
              onClick={() => videoRef.current?.click()}
            >
              🎬 動画
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                onPick(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={videoRef}
              type="file"
              accept="video/mp4,video/webm,video/quicktime"
              hidden
              onChange={(e) => {
                onPickVideo(e.target.files);
                e.target.value = "";
              }}
            />
            <Text size="xs" c="dimmed">
              Cmd/Ctrl + Enter で吠える
            </Text>
          </Group>
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              color="indigo"
              loading={proofreading}
              disabled={text.trim().length <= AI_PROOFREAD_MIN || posting || uploading || videoUploading}
              onClick={handleProofread}
              title={
                text.trim().length > AI_PROOFREAD_MIN
                  ? "AIが本文をMarkdownで校正します"
                  : `AI校正は${AI_PROOFREAD_MIN}文字以上で利用できます`
              }
              leftSection={
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
                </svg>
              }
            >
              AI校正
            </Button>
            <Button
              type="submit"
              size="sm"
              color="green"
              loading={posting}
              disabled={(!text.trim() && images.length === 0 && !video) || uploading || videoUploading}
            >
              吠える
            </Button>
          </Group>
        </Group>
      </form>
      {error && (
        <Text size="sm" mt="sm" c="red">
          {error}
        </Text>
      )}
    </Paper>
  );
}

/**
 * iOS-only custom "pull to refresh" for the timeline.
 *
 * On Android Chrome the browser's native pull-to-refresh already reloads the
 * page, so we leave it alone here. On iOS (Safari browser AND standalone PWA)
 * the native gesture is either missing (standalone) or flaky, so we implement
 * our own: pulling down while the window is at the top reveals a pill
 * indicator, and releasing past the threshold calls onRefresh() (a feed
 * reload). We preventDefault only while actively pulling so our gesture
 * replaces Safari's rubber-band/bounce instead of doubling up with it, and we
 * never interfere with vertical scrolling once scrollY > 0.
 */
function PullToRefresh({
  onRefresh,
  active = true,
}: {
  onRefresh: () => void | Promise<void>;
  active?: boolean;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const barRef = useRef<HTMLDivElement | null>(null);
  const startY = useRef<number | null>(null);
  const pulling = useRef(false);
  const pullPx = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  onRefreshRef.current = onRefresh;

  const MAX = 110;
  const THRESH = 64;

  const applyPull = (px: number) => {
    pullPx.current = px;
    const el = barRef.current;
    if (!el) return;
    if (px <= 0) {
      el.style.transform = "translateY(-70px)";
      el.style.opacity = "0";
      return;
    }
    el.style.transform = `translateY(${-70 + Math.min(px, MAX)}px)`;
    el.style.opacity = String(Math.min(1, px / 44));
  };

  const finishRefresh = () => {
    refreshingRef.current = false;
    setRefreshing(false);
    applyPull(0);
  };

  useEffect(() => {
    const isIOS =
      typeof window !== "undefined" &&
      /iPad|iPhone|iPod/.test(navigator.userAgent as string) &&
      !(window as any).MSStream;
    if (!active || !isIOS) return;

    const onTouchStart = (e: TouchEvent) => {
      if (refreshingRef.current || window.scrollY > 0) {
        startY.current = null;
        return;
      }
      startY.current = e.touches[0].clientY;
      pulling.current = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startY.current === null) return;
      if (window.scrollY > 0) {
        startY.current = null;
        pulling.current = false;
        applyPull(0);
        return;
      }
      const dy = e.touches[0].clientY - startY.current;
      if (dy > 0 && !refreshingRef.current) {
        pulling.current = true;
        if (e.cancelable) e.preventDefault();
        applyPull(dy);
      } else {
        pulling.current = false;
        applyPull(0);
      }
    };
    const onTouchEnd = () => {
      const p = pulling.current;
      startY.current = null;
      pulling.current = false;
      if (p && pullPx.current >= THRESH && !refreshingRef.current) {
        refreshingRef.current = true;
        setRefreshing(true);
        applyPull(MAX); // pin the pill visible while loading
        Promise.resolve(onRefreshRef.current()).finally(finishRefresh);
      } else {
        applyPull(0);
      }
    };

    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    return () => {
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return (
    <div
      ref={barRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
        zIndex: 9999,
        transform: "translateY(-70px)",
        opacity: 0,
        transition: "opacity 0.15s ease",
      }}
    >
      <Paper
        radius="xl"
        p="xs"
        withBorder
        shadow="lg"
        style={{
          background: "var(--bg-surface)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          paddingLeft: 14,
          paddingRight: 14,
        }}
      >
        <Loader size="xs" color="green" />
        <Text size="xs" fw={600}>
          {refreshing ? "更新中…" : "引っ張って更新"}
        </Text>
      </Paper>
    </div>
  );
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
  // ---- Auto unread highlight on/off (persisted, default ON) ----
  const autoUnreadOn = useSyncExternalStore(subscribeRead, getReadSnapshot, () => readServerSnapshot).enabled;

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
    // cache: "no-store" — the GET list is re-read right after add/edit/delete,
    // so the sidebar must always reflect the latest state (never a stale copy).
    fetch("/api/menu-links", { cache: "no-store" })
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
  // Trend keywords (right sidebar): AI search keywords from last 24h, 6h refresh.
  const [trendKeywords, setTrendKeywords] = useState<
    { keyword: string; rank: number; hits: number }[]
  >([]);
  // Post currently being jumped-to from a right-sidebar card (feeds the card's
  // loading indicator while it pages back to fetch the post).
  const [scrollingPostId, setScrollingPostId] = useState<number | null>(null);
  // Post auto-scroll/highlight ref removed (2026-08-17): posting never
  // auto-scrolls the timeline per user request.
  const feedCursorRef = useRef<string | null>(null);
  const feedSentinelRef = useRef<HTMLDivElement | null>(null);
  // Composer collapsed to a small "+" by default (clean timeline); opens into the full form on click.
  const [composerOpen, setComposerOpen] = useState(false);

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
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  // Lightbox navigation + zoom: `previewImages` is the group the current image
  // belongs to (so left/right & swipe move within it); `previewScale`/`previewPan`
  // drive pinch-zoom & pan.
  const [previewImages, setPreviewImages] = useState<string[]>([]);
  const [previewScale, setPreviewScale] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  // Pinch / pan / swipe gesture bookkeeping for the lightbox.
  const lbPointers = useRef(new Map<number, { x: number; y: number }>());
  const lbGesture = useRef({
    startDist: 0,
    startScale: 1,
    startX: 0,
    startY: 0,
    startT: 0,
    startPan: { x: 0, y: 0 },
    mode: "none" as "none" | "pinch" | "pan" | "tap",
  });
  // Open the full-screen lightbox, remembering the surrounding image group so
  // keyboard arrows / swipes can switch between images.
  const openPreview = useCallback((src: string, group?: string[]) => {
    setPreviewImages(group && group.length ? group : [src]);
    setPreviewScale(1);
    setPreviewPan({ x: 0, y: 0 });
    setPreviewImage(src);
  }, []);
  const navigatePreview = useCallback(
    (delta: number) => {
      const cur = previewImage;
      if (!cur) return;
      const group = previewImages.length ? previewImages : [cur];
      const idx = group.indexOf(cur);
      if (idx === -1) return;
      const next = group[(idx + delta + group.length) % group.length];
      setPreviewScale(1);
      setPreviewPan({ x: 0, y: 0 });
      setPreviewImage(next);
    },
    [previewImage, previewImages]
  );
  const [editingPost, setEditingPost] = useState<FeedPost | null>(null);
  const [editText, setEditText] = useState("");
  const [editImages, setEditImages] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<FeedPost | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ---- Profile timeline view ----
  const [profileEmail, setProfileEmail] = useState<string | null>(null);
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [profilePosts, setProfilePosts] = useState<FeedPost[]>([]);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileHasMore, setProfileHasMore] = useState(false);
  const [profileBefore, setProfileBefore] = useState<string | null>(null);
  const profileEmailRef = useRef<string | null>(null);
  profileEmailRef.current = profileEmail;
  // ---- Profile edit modal ----
  const [editingProfile, setEditingProfile] = useState(false);
  const [profileForm, setProfileForm] = useState({ displayName: "", bio: "", headerImage: "" });
  const [profileLinks, setProfileLinks] = useState<{ label: string; href: string }[]>([]);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileUploading, setProfileUploading] = useState(false);
  const profileHeaderRef = useRef<HTMLInputElement>(null);
  // Header-image banner crop editor (drag-to-pan + zoom, then crop+resize)
  const [cropModalOpen, setCropModalOpen] = useState(false);
  const [cropSource, setCropSource] = useState<{ url: string; file: File } | null>(null);

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

  // X-style keyboard navigation: the post currently under keyboard focus.
  const [kbdCursorId, setKbdCursorId] = useState<number | null>(null);
  // Hold the latest action handlers so the singleton keydown listener never
  // reads a stale closure (these plain fns are recreated every render).
  const kbdRef = useRef<{
    openThread: (id: number) => void;
    openThreadReply: (id: number) => void;
    closeThread: () => void;
    like: (id: number) => void;
    openComposer: () => void;
    hasThread: boolean;
  } | null>(null);
  // Inline "insert between cards" reply state (timeline group comments).
  // NOTE: the inline box's TEXT/IMAGE/UPLOAD state lives inside InlineReplyBox
  // (self-contained, like ComposerPaper) so typing there no longer re-renders
  // the whole page. Only the open/guard state lives at the page root.
  const [inlineReplyFor, setInlineReplyFor] = useState<number | null>(null);
  const [inlineReplying, setInlineReplying] = useState<'comment' | 'whisper' | false>(false);

  // Image attachments for replies (thread just the thread box; the inline box
  // owns its own images locally).
  const [threadReplyImages, setThreadReplyImages] = useState<string[]>([]);
  const [threadUploading, setThreadUploading] = useState(false);
  // At most one video attachment on the thread reply box.
  const [threadReplyVideo, setThreadReplyVideo] = useState<string | null>(null);
  const [threadVideoUploading, setThreadVideoUploading] = useState(false);

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

  // ---- Composer focus detection ----
  // When the user is typing in any text field on mobile, the floating chat
  // bubble (bottom-right, zIndex 2900) sits right above the iOS/Android
  // keyboard and covers the reply composer's action row (📷/うなる/吠える).
  // Hide the widget whenever a text input has focus (unless the CHAT itself is
  // the thing being typed — then the chat panel must stay up). Generalizes the
  // earlier edit-modal-only guard (0e06eec).
  const [inputFocused, setInputFocused] = useState(false);
  useEffect(() => {
    const onFocus = () => {
      const t = document.activeElement as HTMLElement | null;
      setInputFocused(
        !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")
      );
    };
    const onBlur = () => setInputFocused(false);
    document.addEventListener("focusin", onFocus);
    document.addEventListener("focusout", onBlur);
    return () => {
      document.removeEventListener("focusin", onFocus);
      document.removeEventListener("focusout", onBlur);
    };
  }, []);

  const editFileRef = useRef<HTMLInputElement>(null);

  // ---- Notifications state ----
  const [notifications, setNotifications] = useState<any[]>([]);
  // ---- Web Push (自動新着通知) state ----
  const [pushSupported, setPushSupported] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
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

  // Holds the latest openThread so the mount-time hashchange listener never
  // captures a stale closure (openThread is a plain fn recreated every render).
  const openThreadRef = useRef<(postId: number) => void>(() => {});
  const openProfileRef = useRef<(email: string) => void>(() => {});

  useEffect(() => {
    checkAuth();
    // Support browser back button: when the #/post hash is removed (via the
    // back button or history.back()), close the thread view.
    const onPop = () => {
      const h = window.location.hash || "";
      if (h.startsWith("#/user/")) {
        openProfileRef.current(decodeURIComponent(h.slice("#/user/".length)));
        return;
      }
      if (!h.startsWith("#/post/")) {
        setThreadPost(null);
        setThreadReplies([]);
        setThreadReplyBoxOpen(false);
        setProfileEmail(null);
        setProfileData(null);
        setProfilePosts([]);
        setProfileBefore(null);
      }
    };
    // A hash-only change on an already-open tab (e.g. a Web Push notification
    // click that navigates the existing window/browser tab to #/post/<id>)
    // fires `hashchange`, NOT `popstate`. Without this, tapping a push while
    // B-guru is already open leaves the app on the top feed instead of jumping
    // to the post. `history.pushState` (used by openThread) does NOT fire
    // hashchange, so this never loops.
    const onHash = () => {
      const h = window.location.hash || "";
      if (h.startsWith("#/user/")) {
        const id = decodeURIComponent(h.slice("#/user/".length));
        if (id) openProfileRef.current(id);
        return;
      }
      if (h.startsWith("#/post/")) {
        const pid = Number(h.slice("#/post/".length));
        if (pid && pid > 0) openThreadRef.current(pid);
      } else {
        setThreadPost(null);
        setThreadReplies([]);
        setThreadReplyBoxOpen(false);
        setProfileEmail(null);
        setProfileData(null);
        setProfilePosts([]);
        setProfileBefore(null);
      }
    };
    window.addEventListener("popstate", onPop);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("hashchange", onHash);
    };
  }, [checkAuth]);

  useEffect(() => {
    if (!auth) {
      setFeedLoading(false);
      return;
    }
    loadFeed();
    loadPinned();
    loadHot();
    loadTrends();
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
    // Deep-link from a profile permalink: #/user/<userId> (or legacy email)
    const profileHash = window.location.hash || "";
    if (profileHash.startsWith("#/user/")) {
      const id = decodeURIComponent(profileHash.slice("#/user/".length));
      if (id) {
        const t = window.setTimeout(() => openProfileRef.current(id), 300);
        return () => window.clearTimeout(t);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  // ---- Web Push: register SW (once) and reflect current subscription state ----
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    setPushSupported(true);
    let disposed = false;
    (async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/" });
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!disposed) setPushEnabled(!!sub);
      } catch (e) {
        console.error("SW/Push init:", e);
      }
    })();
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggle 自動新着通知 (Web Push) on/off. Requests permission when enabling.
  const onTogglePush = useCallback(
    async (enabled: boolean) => {
      if (!pushSupported || typeof window === "undefined") return;
      setPushBusy(true);
      try {
        if (enabled) {
          const perm = await Notification.requestPermission();
          if (perm !== "granted") {
            setPushEnabled(false);
            return;
          }
          const reg = await navigator.serviceWorker.ready;
          const r = await fetch("/api/push/vapid-public-key", { cache: "no-store" });
          if (!r.ok) throw new Error("vapid key 取得失敗");
          const data = await r.json();
          let sub = await reg.pushManager.getSubscription();
          if (!sub) {
            sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(data.publicKey),
            });
          }
          const raw = sub.toJSON();
          const save = await fetch("/api/push/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              endpoint: sub.endpoint,
              keys: { p256dh: raw.keys?.p256dh, auth: raw.keys?.auth },
              userAgent: navigator.userAgent,
            }),
          });
          if (!save.ok) throw new Error("subscribe 保存失敗");
          setPushEnabled(true);
        } else {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          if (sub) {
            const endpoint = sub.endpoint;
            try {
              await sub.unsubscribe();
            } catch {}
            await fetch("/api/push/subscribe", {
              method: "DELETE",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ endpoint }),
            }).catch(() => {});
          }
          setPushEnabled(false);
        }
      } catch (e) {
        console.error("push toggle:", e);
      } finally {
        setPushBusy(false);
      }
    },
    [pushSupported]
  );

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

  const loadTrends = useCallback(() => {
    if (!auth) {
      setTrendKeywords([]);
      return;
    }
    fetch("/api/trends", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.keywords)) setTrendKeywords(d.keywords);
      })
      .catch(() => {});
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

  // ---- Realtime chat (single global room) — bottom-right bubble widget ----
  // Opens a mini chat window where online members chat live over SSE. This
  // replaces the old "wave" (👋) feature: the bubble sits where the wave
  // animation used to float, and clicking an online member opens the chat.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatUnread, setChatUnread] = useState(0);
  const [chatText, setChatText] = useState("");
  // Target member for a mention-pre-filled chat open (clicking an online row).
  const [chatMention, setChatMention] = useState<string | null>(null);
  const [chatSending, setChatSending] = useState(false);
  const chatOpenRef = useRef(false); // ref so the SSE handler stays stable
  const chatListRef = useRef<HTMLDivElement>(null);
  // Beagle "bark" when the current user is @mentioned while the chat window is
  // closed: bumps `barkKey` to remount the center-screen bark overlay, and
  // remembers who barked for the caption. `myNameRef` holds this user's own
  // display names so the SSE handler can detect mentions without re-creating
  // the EventSource (refs never retrigger the effect).
  const [barkKey, setBarkKey] = useState(0);
  const [barkFrom, setBarkFrom] = useState("");
  const myNameRef = useRef<Set<string>>(new Set());

  // Keep `myNameRef` in sync with the current user's name(s) — from the member
  // list (authoritative) plus the session's name/email as fallbacks.
  useEffect(() => {
    const s = new Set<string>();
    const me = mentionMembers.find((m) => m.email === auth?.email);
    if (me?.name) s.add(normWs(me.name));
    if (auth?.name) s.add(normWs(auth.name));
    if (auth?.email) s.add(normWs(auth.email.split("@")[0]));
    myNameRef.current = s;
  }, [auth, mentionMembers]);

  // Bark sound: preload the /bark.mp3 buffer on mount and resume the (lazily
  // created) AudioContext on the first user gesture. Browsers refuse audio
  // that starts outside a user gesture, so we resume on pointer/key input —
  // once the user has interacted, the bark SE can play.
  useEffect(() => {
    loadBarkBuf();
    const resume = () => ensureBarkCtx();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
    window.addEventListener("touchstart", resume, { once: true });
    return () => {
      window.removeEventListener("pointerdown", resume);
      window.removeEventListener("keydown", resume);
      window.removeEventListener("touchstart", resume);
    };
  }, []);

  // Play the bark sound effect every time a bark animation starts.
  useEffect(() => {
    if (barkKey > 0) playBark();
  }, [barkKey]);

  // Load history + unread count. When `open`, also mark everything read and
  // clear the badge (bubble was just tapped). Uses functional setState + a ref
  // so it can be listed in the SSE effect deps without recreating the
  // EventSource (see the SSE "Effect dependency" pitfall).
  const loadChat = useCallback(async (open?: boolean) => {
    try {
      const r = await fetch("/api/chat", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setChatMessages(d.messages ?? []);
      if (open) {
        setChatUnread(0);
        fetch("/api/chat/read", { method: "POST" }).catch(() => {});
      } else {
        setChatUnread(d.unreadCount ?? 0);
      }
    } catch {
      /* ignore */
    }
  }, []);

  // Open the chat window (fresh history + mark read).
  const openChat = useCallback(() => {
    chatOpenRef.current = true;
    setChatOpen(true);
    loadChat(true);
  }, [loadChat]);

  // Open the chat pre-filled with a mention to `name` and focus the composer.
  // Used when the user clicks an online member: open + @mention + focus.
  const openChatMention = useCallback(
    (name: string) => {
      const token = name.includes(" ") ? `@[${name}] ` : `@${name} `;
      setChatText(token);
      setChatMention(name);
      chatOpenRef.current = true;
      setChatOpen(true);
      loadChat(true);
    },
    [loadChat]
  );

  // Close the chat window (messages kept so reopening is instant).
  const closeChat = useCallback(() => {
    chatOpenRef.current = false;
    setChatOpen(false);
    setChatMention(null);
  }, []);

  // Send a chat message (callback memo ties to current input text).
  const sendChat = useCallback(async () => {
    const body = chatText.trim();
    if (!body || chatSending) return;
    setChatSending(true);
    try {
      const r = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
        cache: "no-store",
      });
      const d = await r.json();
      if (d.ok && d.message) {
        setChatMessages((prev) =>
          prev.some((m) => m.id === d.message.id) ? prev : [...prev, d.message]
        );
        setChatText("");
        setChatUnread(0); // our own message counts as read
      }
    } catch {
      /* ignore */
    }
    setChatSending(false);
  }, [chatText, chatSending]);

  // Auto-scroll the message list to the bottom when it grows while open.
  useEffect(() => {
    if (chatOpenRef.current && chatListRef.current) {
      const el = chatListRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [chatMessages, chatOpen]);

  // Load initial chat history + unread badge on login (before opening).
  useEffect(() => {
    if (auth) loadChat(false);
  }, [auth, loadChat]);

  // ---- TEMP diagnostic (2026-08-13, drikin): surface client JS errors on the
  // page so a freeze during commenting (form not closing / not reflecting while
  // the POST persists) can be traced to the exact exception. Remove after the
  // root cause is found. Shows a red badge bottom-left; click to dismiss.
  const [clientErr, setClientErr] = useState<{ msg: string; at: string } | null>(null);
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      const msg = e.message || String(e.error || "");
      // "ResizeObserver loop completed with undelivered notifications" is a
      // benign browser quirk, not an app error — filtering it keeps the badge
      // focused on real failures (it otherwise fires constantly and misleads).
      if (msg.includes("ResizeObserver")) return;
      const at = `${e.filename ? e.filename.split("/").pop() + ":" + e.lineno : "?"}`;
      setClientErr({ msg: msg.slice(0, 220), at });
      console.error("[GlobalError]", e.error || e);
    };
    const onRej = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      setClientErr({ msg: (r instanceof Error ? r.message : String(r)).slice(0, 220), at: "unhandledrejection" });
      console.error("[GlobalError:rejection]", r);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  const FEED_PAGE = 50;

  const loadFeed = (filter?: string, search?: string) => {
    setFeedLoading(true);
    setFeedHasMore(true);
    feedCursorRef.current = null;
    const s = search?.trim();
    const q = `?limit=${FEED_PAGE}${filter ? `&filter=${filter}` : ""}${s ? `&search=${encodeURIComponent(s)}` : ""}`;
    return fetch(`/api/posts${q}`, { cache: "no-store" })
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

  // Pull-to-refresh: reload the current feed view. Invoked by the iOS-only
  // custom pull gesture (<PullToRefresh/>). Android Chrome keeps its native
  // pull-to-refresh (full page reload), so this is only wired up on iOS.
  const pullRefresh = useCallback(() => {
    const filter =
      activeNav === "gallery"
        ? "images"
        : activeNav === "news"
        ? "links"
        : activeNav === "episodes"
        ? "episodes"
        : undefined;
    return loadFeed(filter, searchQueryRef.current.trim() || undefined);
  }, [activeNav]);

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
  const feedPostsRef = useRef(feedPosts);
  feedPostsRef.current = feedPosts;

  // TEMPORARY (2026-08-13, drikin request): disable SSE-triggered *timeline*
  // auto-refresh to eliminate races with optimistic posting. Live push of
  // OTHER members' timeline reordering is intentionally suspended; posting
  // still works via the optimistic insert + POST-response swap. The Right
  // sidebar panels (hot/pin/presence/wave) stay live — they don't touch the
  // timeline's order. Re-enable by flipping this to `true` and re-reviewing
  // the SSE merge (`mergeFreshFeed`) timing against optimistic inserts.
  const ENABLE_PUSH_TIMELINE_REFRESH = false;

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
          setFeedPosts((prev) => mergeFreshFeed(prev, fresh));
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
      let action: string | undefined;
      try {
        const d = JSON.parse(e.data);
        authorEmail = d?.authorEmail;
        action = d?.action;
      } catch {}
      if (auth && authorEmail && authorEmail === auth.email) {
        // Still refresh hot topics (other people's view of activity changed)
        loadHot();
        return;
      }
      // Timeline auto-refresh is disabled per drikin, so an incoming new
      // post/comment does NOT enter feedPosts while the page is open. Count it
      // as pending so the beagle NEW badge appears live for arrivals not yet
      // loaded (cleared by tapping the logo / reload).
      if (action === "create") bumpPendingNew();
      loadHot(); // new post/comment may change the hot-topics ranking
      if (ENABLE_PUSH_TIMELINE_REFRESH && !threadPostRef.current) silentRefreshFeed();
    };
    const onPinChange = () => {
      loadPinned(); // refresh the right-sidebar pin summary panel
      if (ENABLE_PUSH_TIMELINE_REFRESH && !threadPostRef.current) silentRefreshFeed();
    };
    const onPresenceChange = () => {
      loadOnline(); // refresh the right-sidebar online panel
    };
    // Realtime chat: append created messages live; drop deleted ones. When the
    // chat window is closed and the message isn't ours, bump the unread badge.
    // When open, clear the badge and mark read.
    const onChat = (e: MessageEvent) => {
      let d: any;
      try {
        d = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!d || d.type !== "chat" || !auth) return;
      if (d.action === "create" && d.message?.id) {
        const msg = d.message as ChatMessage;
        setChatMessages((prev) =>
          prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]
        );
        if (chatOpenRef.current) {
          setChatUnread(0);
          fetch("/api/chat/read", { method: "POST" }).catch(() => {});
        } else if (msg.authorEmail !== auth.email) {
          setChatUnread((u) => u + 1);
          // This message @mentions the current user: on top of the unread
          // badge, make the beagle bark in the center of the screen so the
          // message really demands attention (remount via barkKey restart).
          if (isMentionedIn(msg.body, myNameRef.current)) {
            setBarkKey((k) => k + 1);
            setBarkFrom(msg.authorName || msg.authorEmail);
          }
        }
      } else if (d.action === "delete" && d.message?.id != null) {
        const delId = d.message.id as number;
        setChatMessages((prev) => prev.filter((m) => m.id !== delId));
      }
    };
    es.addEventListener("post", onChange);
    es.addEventListener("pin", onPinChange);
    es.addEventListener("presence", onPresenceChange);
    es.addEventListener("chat", onChat);
    es.onopen = () => {
      loadPinned();
      loadHot();
      loadTrends();
      loadOnline();
      loadChat(chatOpenRef.current); // recover chat missed during a disconnect
      if (ENABLE_PUSH_TIMELINE_REFRESH && !threadPostRef.current) silentRefreshFeed();
    };
    es.onerror = () => {
      // EventSource auto-reconnects. When it does, onopen fires and we
      // silentRefreshFeed() to recover any events missed during the
      // disconnect. Nothing to do here — the reconnect + onopen handles it.
    };
    return () => {
      es.close();
    };
  }, [auth, silentRefreshFeed, loadPinned, loadHot, loadOnline, loadChat]);

  // Posting never auto-scrolls or auto-highlights the timeline (disabled per
  // user request, 2026-08-17): a new reply is simply added to the feed in
  // place and the viewport is left untouched.

  // Periodic self-heal for the online panel: refresh even if a presence SSE
  // event or onopen callback was missed (e.g. iOS Safari dropping the stream).
  useEffect(() => {
    if (!auth) return;
    loadOnline();
    const t = window.setInterval(loadOnline, 60000);
    return () => window.clearInterval(t);
  }, [auth, loadOnline]);

  // Presence heartbeat: POST /api/presence/ping every 30s so the server keeps
  // us "online" even when the SSE stream is briefly dropped (mobile tab
  // suspension, network blips). Also ping + refresh when the tab becomes
  // visible again so returning restores presence immediately instead of waiting
  // for the SSE reconnect.
  useEffect(() => {
    if (!auth) return;
    const ping = () => {
      fetch("/api/presence/ping", { method: "POST", cache: "no-store" }).catch(() => {});
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        ping();
        loadOnline();
      }
    };
    ping();
    const t = window.setInterval(ping, 30000);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
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
    const q = searchQueryRef.current.trim();
    if (q) {
      loadFeed(undefined, q);
    } else if (searchActive) {
      // Search was cleared — reload normal feed
      loadFeed();
    }
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

  // Upload a single video file (at most 20MB) to /api/upload and set the
  // attachment URL. `clearPrev` (optional) runs right before the URL is set so
  // a replaced attachment drops its old selection.
  const uploadVideo = async (
    files: FileList | null,
    setUrl: (v: string) => void,
    setUp: (v: boolean) => void,
    setErr: (v: string) => void,
    clearPrev?: () => void
  ) => {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (f.size > 20 * 1024 * 1024) {
      setErr("動画は20MBまでです");
      return;
    }
    if (!["video/mp4", "video/webm", "video/quicktime"].includes(f.type)) {
      setErr("対応形式: MP4 / WebM / MOV");
      return;
    }
    setUp(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("video", f);
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "動画アップロード失敗");
      clearPrev?.();
      setUrl(d.videoUrl);
    } catch (err: any) {
      setErr(err.message);
    } finally {
      setUp(false);
    }
  };

  const onThreadReplyPick = (files: FileList | null) =>
    uploadImages(files, threadReplyImages, setThreadReplyImages, setThreadUploading, (s) =>
      setReplyError(s)
    );

  const onThreadReplyPickVideo = (files: FileList | null) =>
    uploadVideo(files, setThreadReplyVideo, setThreadVideoUploading, (s) => setReplyError(s));

  const removeThreadReplyVideo = () => setThreadReplyVideo(null);

  const removeThreadReplyImage = (i: number) =>
    setThreadReplyImages((prev) => prev.filter((_, idx) => idx !== i));

  // Publish a new root post. Text/images come in as args (the composer owns its
  // own local text/image state — see ComposerPaper) so typing doesn't re-render
  // the whole page. Does the optimistic insert + API round-trip + swap.
  const publishComposer = useCallback(
    async (text: string, images: string[], videoUrl?: string | null) => {
      const tempId = Date.now();
      const tempPost: FeedPost = {
        id: tempId,
        authorEmail: auth?.email ?? "",
        authorName: auth?.name ?? null,
        authorAvatar: avatarSrc ?? null,
        parentId: null,
        replyCount: 0,
        text,
        images,
        videoUrl: videoUrl ?? null,
        urlPreview: null,
        likeCount: 0,
        likedByMe: false,
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        pinnedAt: null,
        replies: [],
      };
      setFeedPosts((prev) =>
        prev.some((p) => p.id === tempId) ? prev : [tempPost, ...prev]
      );
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000); // guard can't hang forever
      try {
        const r = await fetch("/api/publish", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, images, videoUrl }),
          signal: ac.signal,
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "投稿失敗");
        // Swap the temp post for the authoritative server post.
        if (d.post) {
          setFeedPosts((prev) =>
            prev.some((p) => p.id === d.post.id)
              ? prev.filter((p) => p.id !== tempId) // server post already present (via refresh)
              : prev.map((p) => (p.id === tempId ? d.post : p))
          );
        }
        setComposerOpen(false); // collapse back to the "+" after a successful post
      } catch (err: any) {
        setFeedPosts((prev) => prev.filter((p) => p.id !== tempId));
        throw err; // let ComposerPaper render the error
      } finally {
        clearTimeout(timer);
      }
    },
    [auth, avatarSrc]
  );

  // Reply button: open that post's thread view and show the reply box.
  // Single path — no separate reply popup anymore.
  const openThreadReply = (postId: number) => {
    setReplyText("");
    setThreadReplyImages([]);
    setThreadReplyVideo(null);
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
    if (!threadPost) return;
    const text = replyText.trim();
    if (!text && threadReplyImages.length === 0 && !threadReplyVideo) return;
    await createReply({
      parentId: threadPost.id,
      text,
      images: threadReplyImages,
      videoUrl: threadReplyVideo,
      whisper,
      mode: "thread",
    });
  };

  // ---- Inline "insert between cards" comment (timeline group) ----
  // Box is now self-contained (InlineReplyBox owns text/images locally), so
  // open/close just toggles which post's box is rendered; no text to reset.
  const toggleInlineReply = (postId: number) => {
    setInlineReplyFor((prev) => (prev === postId ? null : postId));
  };
  // Whisper entry (from a card). The box exposes explicit 「ささやく」/「コメント」
  // buttons regardless of entry mode, so opening is the same as a normal reply.
  const toggleWhisper = (postId: number) => {
    setInlineReplyFor((prev) => (prev === postId ? prev : postId));
  };
  const submitInlineReply = async (
    postId: number,
    text: string,
    images: string[],
    whisper: boolean,
    videoUrl?: string | null
  ) => {
    if (!text.trim() && images.length === 0 && !videoUrl) return;
    await createReply({
      parentId: postId,
      text: text.trim(),
      images,
      videoUrl: videoUrl ?? null,
      whisper,
      mode: "inline",
    });
  };

  // ---- Shared reply/whisper creator (used by both the thread and the inline
  // "insert between cards" UIs) ----
  // Unifies two previously near-identical optimistic-insert paths so comments
  // and whispers reflect instantly and CONSISTENTLY in both the thread view and
  // the timeline group. Handles: optimistic temp insert → swap for the server's
  // real reply on success → rollback on failure. If the parent group isn't part
  // of the currently loaded feed, it falls back to a reliable server refresh
  // instead of silently dropping the comment (the "didn't reflect" bug).
  const createReply = async (opts: {
    parentId: number;
    text: string;
    images: string[];
    videoUrl?: string | null;
    whisper: boolean;
    mode: "inline" | "thread";
  }): Promise<void> => {
    const { parentId, text, images, videoUrl, whisper, mode } = opts;
    if (!text && images.length === 0 && !videoUrl) return;
    if (mode === "thread") {
      if (replying) {
        console.warn("[submitBlocked] thread", { replying, parentId });
        return;
      }
      setReplying(whisper ? "whisper" : "comment");
      setReplyError(null);
      setReplyText("");
      setThreadReplyImages([]);
      setThreadWhisper(false);
    } else {
      if (inlineReplying) {
        console.warn("[submitBlocked] inline", { inlineReplying, parentId });
        return;
      }
      setInlineReplying(whisper ? "whisper" : "comment");
      setInlineReplyFor(null); // closes (unmounts) the InlineReplyBox
    }

    // Optimistic reply — appears instantly in the open thread and (when the
    // parent group is loaded) in the timeline.
    const parentWasInFeed = parentInFeed(feedPostsRef.current, parentId);
    const tempId = Date.now();
    const tempReply: FeedPost = {
      id: tempId,
      authorEmail: auth?.email ?? "",
      authorName: auth?.name ?? null,
      authorAvatar: avatarSrc ?? null,
      parentId,
      text,
      images,
      videoUrl: videoUrl ?? null,
      urlPreview: null,
      likeCount: 0,
      likedByMe: false,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      replies: [],
      replyCount: 0,
    };
    if (mode === "thread") {
      setThreadReplies((prev) => [...prev, tempReply]);
    }
    setFeedPosts((prev) =>
      parentInFeed(prev, parentId)
        ? appendReplyLocal(prev, parentId, tempReply, whisper)
        : prev
    );

    // Give the publish fetch an abort timeout so the replying/inlineReplying
    // guard can NEVER stay stuck from a response that never arrives — `finally`
    // below always runs and resets the guard. (A lost response used to leave
    // the guard true forever, silently blocking every later comment: the form
    // stopped closing and nothing reflected locally, which matches the report.)
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);

    try {
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images, videoUrl, parentId, whisper }),
        signal: ac.signal,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "コメント失敗");
      const created = d.post;
      const realReply: FeedPost = {
        ...created,
        id: created.id,
        parentId,
        replies: [],
        replyCount: 0,
      };
      if (mode === "thread") {
        setThreadReplies((prev) =>
          prev.map((rp) => (rp.id === tempId ? realReply : rp))
        );
      }
      // No auto-scroll / highlight after posting (disabled per user request,
      // 2026-08-17): the new reply is reflected in place, viewport untouched.
      setFeedPosts((prev) => {
        // OPTION B: comments no longer bump the group to the top locally; the
        // new order appears only after a server refresh (groupFeed re-sorts by
        // the server's bumped lastActivityAt on the next load).
        return parentInFeed(prev, parentId)
          ? replaceReplyInFeed(prev, parentId, tempId, realReply, whisper)
          : prev;
      });
      // If the parent group wasn't in the loaded feed at all (e.g. we commented
      // on a post beyond the currently loaded pages, opened from a hot topic,
      // pin, or notification), a silentRefreshFeed() of page 1 can't reach it —
      // the parent may sit deeper than the first FEED_PAGE entries, so the
      // comment stayed hidden until a full reload (the "pagination-crossing"
      // bug). Instead, fetch THAT exact parent group from the server and insert
      // it into the local feed so the comment — and its bump — appears right
      // away. groupFeed() re-sorts by lastActivityAt on render, so a non-whisper
      // group lands at the top and a whisper slots into its natural position.
      if (!parentWasInFeed) {
        try {
          const gr = await fetch(`/api/posts/${parentId}`, { cache: "no-store" });
          const gd = await gr.json();
          if (gr.ok && gd?.post) {
            setFeedPosts((prev) =>
              prev.some((p) => p.id === parentId)
                ? prev
                : [
                    {
                      ...(gd.post as FeedPost),
                      replies: gd.replies ?? [],
                      replyCount: (gd.replies ?? []).length,
                    },
                    ...prev,
                  ]
            );
          } else {
            silentRefreshFeed(); // degraded fallback (may still miss a deep parent)
          }
        } catch {
          silentRefreshFeed(); // degraded fallback on network error
        }
      }
    } catch (err: any) {
      // Rollback the optimistic reply (both the feed group and the thread) and
      // restore the THREAD text. The inline box handles its own error display
      // (it is unmounted on submit, so nothing to restore here).
      setFeedPosts((prev) => removeReplyTemp(prev, parentId, tempId));
      if (mode === "thread") {
        setThreadReplies((prev) => prev.filter((rp) => rp.id !== tempId));
        setReplyText(text);
        setReplyError(err.message);
      }
    } finally {
      clearTimeout(timer);
      if (mode === "thread") setReplying(false);
      else setInlineReplying(false);
    }
  };

  // Open the individual thread view (post + chronological replies)
  const openThread = (postId: number) => {
    // Opening a thread must leave any open profile view — ProfileView takes
    // render priority over the thread, so a stale profileEmail would hide the
    // thread the user just tapped (reported bug, 2026-08-19). The #/user hash
    // (if any) is left alone so the back button still returns to the profile.
    setProfileEmail(null);
    // Seed the thread view INSTANTLY from already-loaded data (the clicked
    // root post is in feedPosts and carries its replies in `.replies`) instead
    // of blanking the screen and waiting on a network round-trip. This is what
    // made "card click → filtered timeline" feel slow. The server fetch below
    // then refreshes in the background so counts / new replies stay current.
    const local = findPostLocal(postId);
    setThreadLoading(!local);
    setThreadPost(local);
    setThreadReplies(local ? local.replies ?? [] : []);
    setReplyText("");
    setThreadReplyImages([]);
    setThreadReplyBoxOpen(false);
    setThreadWhisper(false);
    setReplyError(null);
    // Allow the browser back button to close the thread view. Push the hash
    // ONLY when entering a thread from the timeline; if we're already inside a
    // thread (e.g. tapping a reply card in the thread view) REPLACE it so
    // #/post never stacks up — stacking was why "タイムラインに戻る" needed 2 taps.
    const inThread = (window.location.hash || "").startsWith("#/post/");
    const url = `#/post/${postId}`;
    if (inThread) window.history.replaceState({ thread: postId }, "", url);
    else window.history.pushState({ thread: postId }, "", url);
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
  openThreadRef.current = openThread;

  // ---- Profile timeline ----
  // Navigate to a user's profile timeline. On the first entry push #/user/<email>
  // so the back button closes it; when already on a profile (avatar→avatar) REPLACE
  // so the hash never stacks.
  const openProfile = useCallback(
    async (email: string) => {
      const inProfile = (window.location.hash || "").startsWith("#/user/");
      const url = `#/user/${encodeURIComponent(email)}`;
      if (inProfile) window.history.replaceState({ profile: email }, "", url);
      else window.history.pushState({ profile: email }, "", url);
      setThreadPost(null);
      setThreadReplies([]);
      setProfileEmail(email);
      setProfileData(null);
      setProfilePosts([]);
      setProfileLoading(true);
      // Seed the header instantly from an already-loaded card (if any).
      for (const root of feedPosts) {
        for (const p of [root, ...(root.replies ?? [])]) {
          if (p.authorEmail === email) {
            setProfileData({
              email,
              isSelf: !!auth && auth.email === email,
              name: p.authorName || email.split("@")[0],
              avatar: avatarSrc || p.authorAvatar || "",
              bio: "",
              headerImage: null,
              links: [],
              postCount: 0,
              firstPostAt: null,
            });
            break;
          }
        }
      }
      const enc = encodeURIComponent(email);
      try {
        const [hdr, posts] = await Promise.all([
          fetch(`/api/user/${enc}`, { cache: "no-store" }),
          fetch(`/api/user/${enc}/posts?limit=30`, { cache: "no-store" }),
        ]);
        const hd = await hdr.json();
        const pd = await posts.json();
        if (hd.profile) {
          setProfileData(hd.profile);
          // Canonicalize the public URL to the opaque userId (never email).
          if (hd.profile.userId) {
            const canon = `#/user/${encodeURIComponent(hd.profile.userId)}`;
            window.history.replaceState({ profile: hd.profile.userId }, "", canon);
          }
        }
        setProfilePosts(pd.posts ?? []);
        setProfileHasMore(!!pd.hasMore);
        const last = pd.posts && pd.posts.length ? pd.posts[pd.posts.length - 1] : null;
        setProfileBefore(last ? last.lastActivityAt || last.createdAt : null);
      } catch {
        // keep the seeded header on failure
      } finally {
        setProfileLoading(false);
      }
    },
    [feedPosts, avatarSrc]
  );
  openProfileRef.current = openProfile;

  const closeProfile = useCallback(() => {
    setProfileEmail(null);
    setProfileData(null);
    setProfilePosts([]);
    setProfileBefore(null);
    window.history.replaceState({}, "", "#/");
  }, []);

  const loadMoreProfile = useCallback(async () => {
    if (!profileEmailRef.current || !profileBefore || profileLoading) return;
    setProfileLoading(true);
    const enc = encodeURIComponent(profileEmailRef.current);
    try {
      const res = await fetch(
        `/api/user/${enc}/posts?before=${encodeURIComponent(profileBefore)}&limit=30`,
        { cache: "no-store" }
      );
      const pd = await res.json();
      const more = pd.posts ?? [];
      setProfilePosts((prev) => [...prev, ...more]);
      setProfileHasMore(!!pd.hasMore);
      const last = more.length ? more[more.length - 1] : null;
      setProfileBefore(last ? last.lastActivityAt || last.createdAt : null);
    } catch {
      // ignore — pagination is best-effort
    } finally {
      setProfileLoading(false);
    }
  }, [profileBefore, profileLoading]);

  // ---- Profile edit ----
  const openEditProfile = useCallback(() => {
    if (!profileData) return;
    setProfileForm({
      displayName: profileData.displayNameSet ? profileData.name : "",
      bio: profileData.bio,
      headerImage: profileData.headerImage || "",
    });
    const links = profileData.links.length
      ? profileData.links.map((l) => ({ label: l.label || "", href: l.href || "" }))
      : [{ label: "", href: "" }];
    setProfileLinks(links);
    setEditingProfile(true);
  }, [profileData]);

  // Open the header-image crop editor (drag-to-pan + zoom, then crop+resize to
  // the banner aspect). The file itself is NOT uploaded until the user applies
  // a crop, so "/uploads" never receives a full-resolution original.
  const onProfileHeaderPick = useCallback((files: FileList | null) => {
    if (!files || !files[0]) return;
    const file = files[0];
    setCropSource({ url: URL.createObjectURL(file), file });
    setCropModalOpen(true);
    setActionError(null);
  }, []);

  // Upload the cropped banner. CRITICAL: /api/upload reads the "images" field
  // (plural) — a singular "image" field returns "画像が選択されていません" 400.
  const onBannerApply = useCallback(
    (blob: Blob) => {
      setProfileUploading(true);
      (async () => {
        try {
          const fd = new FormData();
          fd.append("images", new File([blob], "banner.jpg", { type: "image/jpeg" }));
          const res = await fetch("/api/upload", { method: "POST", body: fd });
          const d = await res.json();
          if (!res.ok || !d.urls || !d.urls[0]) {
            setActionError("画像のアップロードに失敗しました");
            return;
          }
          setProfileForm((f) => ({ ...f, headerImage: d.urls[0] }));
          setCropModalOpen(false);
          setCropSource((cs) => {
            if (cs) URL.revokeObjectURL(cs.url);
            return null;
          });
        } catch {
          setActionError("画像のアップロードに失敗しました");
        } finally {
          setProfileUploading(false);
        }
      })();
    },
    []
  );

  const saveProfile = useCallback(async () => {
    if (!profileEmailRef.current || profileSaving) return;
    setProfileSaving(true);
    try {
      const res = await fetch(`/api/user/${encodeURIComponent(profileEmailRef.current)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          display_name: profileForm.displayName,
          bio: profileForm.bio,
          header_image: profileForm.headerImage || null,
          links: profileLinks
            .filter((l) => l.href.trim())
            .map((l) => ({ label: l.label.trim(), href: l.href.trim() })),
        }),
      });
      const d = await res.json();
      if (!res.ok) {
        setActionError(d.error || "保存に失敗しました");
        return;
      }
      setProfileData(d.profile);
      setEditingProfile(false);
    } catch {
      setActionError("保存に失敗しました");
    } finally {
      setProfileSaving(false);
    }
  }, [profileSaving, profileForm, profileLinks]);

  // Find a post we've already loaded (root cards, their nested inline replies,
  // and pinned/hot sidebar posts) by id — used to seed thread views instantly.
  const findPostLocal = (postId: number): FeedPost | null => {
    for (const root of feedPosts) {
      if (root.id === postId) return root;
      const inReplies = (root.replies ?? []).find((r) => r.id === postId);
      if (inReplies) return inReplies;
    }
    return (
      pinnedPosts.find((p) => p.id === postId) ??
      hotPosts.find((p) => p.id === postId) ??
      null
    );
  };

  const closeThread = () => {
    // Deterministically close the thread: clear the view and normalize the URL
    // back to the timeline with replaceState (NOT history.back()). This always
    // returns in a single tap regardless of how the thread was entered (card
    // click, nested reply, deep link). With openThread now using replaceState
    // for nested navigation, there is never more than one #/post entry that
    // could stack the back button. Browser back/forward on a pushed hash is
    // still handled by the popstate listener.
    setThreadPost(null);
    setThreadReplies([]);
    setThreadReplyBoxOpen(false);
    if ((window.location.hash || "").startsWith("#/post/")) {
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // ignore — hash normalization is best-effort
      }
    }
    // Use silent diff refresh instead of full reload — preserves scroll
    // position and loaded older pages while syncing reply counts.
    silentRefreshFeed();
  };

  // Return to the top/home (feed) view from anywhere — including from a thread.
  const goHome = () => {
    // Explicitly refresh the timeline: the user asked that the header logo and
    // the sidebar タイムライン link always reload the feed. If we're already
    // viewing the feed the activeNav effect won't re-run (nav unchanged), so
    // reload here; when switching in from another tab the effect already
    // loads it, so we skip to avoid a double fetch.
    const wasOnFeed = activeNavRef.current === "feed";
    setActiveNav("feed");
    setThreadPost(null);
    setThreadReplies([]);
    setInlineReplyFor(null);
    setNavOpened(false);
    // Closing the profile view + right panel here is what makes the sidebar
    // 「タイムライン」link work while the profile (or the right drawer) is open —
    // ProfileView takes priority over the feed in render order, so leaving
    // profileEmail set would keep showing the profile (reported bug, 2026-08-19).
    setProfileEmail(null);
    setAsideOpened(false);
    // Clear search when going home
    if (searchQuery) setSearchQuery("");
    if (window.location.hash.startsWith("#/post/") || window.location.hash.startsWith("#/user/")) {
      // Replace the hash so we don't leave the thread/profile in history (a
      // stale #/user/ would re-open the profile on reload after going home).
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // ignore
      }
    }
    if (wasOnFeed) loadFeed();
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

  // Close full-screen lightbox with Escape; arrow keys switch images
  useEffect(() => {
    if (!previewImage) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPreviewImage(null);
      else if (e.key === "ArrowLeft") navigatePreview(-1);
      else if (e.key === "ArrowRight") navigatePreview(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [previewImage, navigatePreview]);

  // Wire the singleton keydown handler to the current render's action closures
  // (plain fns are recreated every render; never read a stale one).
  kbdRef.current = {
    openThread,
    openThreadReply,
    closeThread,
    like: handleLike,
    openComposer: () => setComposerOpen(true),
    hasThread: !!threadPost,
  };

  // X-style keyboard navigation (like X / Twitter):
  //   j / ↓ ... next card,  k / ↑ ... previous card (wraps)
  //   Enter ... open the focused thread,  Esc ... close thread / clear focus
  //   Space ... scroll the focused card into view,  r ... reply,  l ... like
  //   c ... open the new-post composer,  G ... scroll to bottom
  // Skipped on touch devices and while typing in an input.
  useEffect(() => {
    if ("ontouchstart" in window) return;
    const isEditable = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el) return false;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
      return !!el.closest?.("input, textarea, select, [contenteditable=true]");
    };
    // Only cards in the center column (excludes sidebar/navbar pinned cards),
    // and only ones that are actually painted. The painted check skips both
    // display:none cards and replies sitting inside a CLOSED Mantine <Collapse>
    // (height:0 + overflow:hidden) — otherwise the focus ring lands on a hidden
    // card and visually "disappears".
    const isVisibleCard = (el: HTMLElement) => {
      if (el.offsetParent === null) return false; // display:none somewhere up the chain
      let n: HTMLElement | null = el;
      while (n && n !== document.body) {
        const cs = getComputedStyle(n);
        if (/hidden|clip|auto|scroll/.test(cs.overflow) && n.clientHeight === 0) return false;
        n = n.parentElement;
      }
      return true;
    };
    const mainCards = () => {
      const main = document.querySelector<HTMLElement>('[data-cx="main"]');
      if (!main) return [];
      return Array.from(main.querySelectorAll<HTMLElement>("[data-kbd-id]"))
        .filter(isVisibleCard)
        .map((el) => Number(el.dataset.kbdId));
    };
    const setRing = (id: number | null) => {
      document.querySelectorAll<HTMLElement>(".kbd-focus").forEach((el) => {
        el.classList.remove("kbd-focus");
        el.style.outline = "";
        el.style.outlineOffset = "";
        el.style.scrollMarginTop = "";
      });
      if (id == null) return;
      const el = document
        .querySelector<HTMLElement>('[data-cx="main"]')
        ?.querySelector<HTMLElement>(`[data-kbd-id="${id}"]`);
      if (el) {
        el.classList.add("kbd-focus");
        el.style.outline = "3px solid var(--mantine-color-green-6, #2f9e44)";
        el.style.outlineOffset = "2px";
        // A fixed 56px header overlays the top of the scroll area; offset the
        // focus target so the card lands just below it, not under it.
        el.style.scrollMarginTop = "60px";
        requestAnimationFrame(() => el.scrollIntoView({ block: "start" }));
      }
    };
    const move = (dir: 1 | -1) => {
      const ids = mainCards();
      if (!ids.length) return;
      let next: number;
      if (kbdCursorId == null) {
        // No cursor yet: start from the very top for EITHER direction.
        // (Jumping to ids[last] on an initial K would land at the tail of the
        // paginated feed, which is confusing — always begin at the head.)
        next = ids[0];
      } else {
        const i = ids.indexOf(kbdCursorId);
        if (i < 0) {
          next = dir === 1 ? ids[0] : ids[ids.length - 1];
        } else if (dir === 1) {
          // Clamp at the tail (no wrap): lets pagination append fresh cards.
          next = i + 1 < ids.length ? ids[i + 1] : ids[i];
        } else {
          // Clamp at the head (no wrap).
          next = i - 1 >= 0 ? ids[i - 1] : ids[i];
        }
      }
      setKbdCursorId(next);
      setRing(next);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      switch (e.key) {
        case "j": case "J": case "ArrowDown": e.preventDefault(); move(1); break;
        case "k": case "K": case "ArrowUp": e.preventDefault(); move(-1); break;
        case "Enter":
          if (kbdCursorId != null && kbdRef.current) kbdRef.current.openThread(kbdCursorId);
          break;
        case "Escape":
          if (!kbdRef.current) break;
          if (kbdRef.current.hasThread) kbdRef.current.closeThread();
          else if (kbdCursorId != null) { setKbdCursorId(null); setRing(null); }
          break;
        case " ":
          if (kbdCursorId != null) {
            e.preventDefault();
            document
              .querySelector<HTMLElement>('[data-cx="main"]')
              ?.querySelector<HTMLElement>(`[data-kbd-id="${kbdCursorId}"]`)
              ?.scrollIntoView({ block: "center", behavior: "smooth" });
          }
          break;
        case "r": if (kbdCursorId != null && kbdRef.current) kbdRef.current.openThreadReply(kbdCursorId); break;
        case "R": window.location.reload(); break; // Shift+r = hard reload
        case "l": case "L": if (kbdCursorId != null && kbdRef.current) kbdRef.current.like(kbdCursorId); break;
        case "c": case "C": if (kbdRef.current) kbdRef.current.openComposer(); break;
        case "G": window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" }); break;
        // T = return to the very top of the timeline (and clear keyboard focus)
        case "t": case "T":
          setKbdCursorId(null);
          setRing(null);
          window.scrollTo({ top: 0, behavior: "smooth" });
          break;
        // E = expand any comment sections that are currently folded (collapsed).
        // A folded Mantine <Collapse> is an unstyled DIV with inline
        // opacity:0 (+ display:none) that still holds [data-kbd-id] cards.
        case "e": case "E": {
          const main = document.querySelector<HTMLElement>('[data-cx="main"]');
          if (!main) break;
          const toggles = Array.from(main.querySelectorAll<HTMLElement>("*")).filter(
            (el) => el.children.length === 0 && /件のコメントを表示/.test(el.textContent || "")
          );
          const folds = Array.from(main.querySelectorAll<HTMLElement>("div")).filter(
            (el) => el.style.opacity === "0" && el.querySelector("[data-kbd-id]")
          );
          const seen = new Set<HTMLElement>();
          for (const fold of folds) {
            if (seen.has(fold)) continue;
            seen.add(fold);
            // Toggle = the last "件のコメントを表示" element that precedes this fold.
            let toggle: HTMLElement | null = null;
            for (const t of toggles) {
              if (t.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING) toggle = t;
            }
            if (toggle) toggle.click();
          }
          break;
        }
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [kbdCursorId]);

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

  // First group's date key on the home feed — used to render the topmost date
  // separator ABOVE the "+" composer (order: 日付 → プラス), and to tell
  // TimelineFeed to skip its own duplicate of that first separator.
  const composerGroups = activeNav === "feed" ? groupFeed(feedPosts) : [];
  const topDateKey = composerGroups.length > 0 ? composerGroups[0].dateKey : null;

  return (
    <AppShell
      className="appshell-center"
      header={{ height: 56 }}
      navbar={{ width: { base: 220, lg: 250 }, breakpoint: "sm", collapsed: { mobile: !navOpened } }}
      aside={{ width: { base: 280, lg: 300 }, breakpoint: "lg", collapsed: { mobile: !asideOpened } }}
      padding={0}
    >
      {/* Header */}
      <AppShell.Header data-cx="header" style={{ background: "var(--bg-surface)", borderBottom: "1px solid var(--border-default)" }}>
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
          {/* Left: beagle logo on mobile — replaces the left hamburger (drikin 2026-08).
              The logo retains the left hamburger's role: tapping it opens the left menu.
              The center logo (back to timeline top) is dropped on mobile. */}
          <Group gap="xs" wrap="nowrap">
            <UnstyledButton
              onClick={() => {
                // The mobile beagle logo opens the LEFT menu. If the right
                // panel (header burger) is open, close it too — otherwise both
                // drawers stay open and, at the same z-index, the right one
                // (later in DOM order) always covers the left (reported bug,
                // 2026-08-19).
                setNavOpened((o) => !o);
                setAsideOpened(false);
                // Beagle logo (mobile, menu button): clears the live "新着"
                // badge (SSE pending). Timeline unread is untouched.
                clearPendingNew();
              }}
              aria-label="メニューを開く"
              hiddenFrom="sm"
              style={{
                cursor: "pointer",
                background: "transparent",
                border: "none",
                padding: 0,
                lineHeight: 0,
                display: "flex",
                alignItems: "center",
                position: "relative",
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
              {auth && <FeedNewBadge />}
            </UnstyledButton>
          </Group>
          {/* Center: beagle logo on desktop */}
          <UnstyledButton
            onClick={() => {
              // Beagle logo (desktop, home button): clear the live "新着" badge
              // (SSE pending), then return to the timeline top. Timeline unread
              // is untouched.
              clearPendingNew();
              goHome();
            }}
            aria-label="タイムラインへ戻る"
            visibleFrom="sm"
            style={{
              cursor: "pointer",
              background: "transparent",
              border: "none",
              padding: 0,
              lineHeight: 0,
              position: "absolute",
              // Align to the horizontal center of the CENTER timeline column
              // (between the left navbar and right aside), not the window center.
              left: "calc(var(--app-shell-navbar-width, 220px) + (100% - var(--app-shell-navbar-width, 220px) - var(--app-shell-aside-width, 280px)) / 2)",
              top: "50%",
              transform: "translate(-50%, -50%)",
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
              {auth && <FeedNewBadge />}
            </UnstyledButton>
          {/* Right: hamburger (mobile/tablet) — opens the right sidebar + unread badge. Kept. */}
          <Group gap="sm" wrap="nowrap">
            <Burger
              opened={asideOpened}
              onClick={() => setAsideOpened((o) => !o)}
              size="sm"
              hiddenFrom="lg"
              aria-label="右パネルを開く"
            />
          </Group>
        </div>
      </AppShell.Header>

      {/* Left sidebar */}
      <AppShell.Navbar data-cx="navbar" p="xs" style={{ background: "var(--bg-primary)", borderRight: "1px solid var(--border-default)" }}>
        <ScrollArea>
          <Stack gap={2}>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.key}
                active={activeNav === item.key}
                label={item.label}
                leftSection={<span>{item.icon}</span>}
                onClick={() => {
                  // Switching views from the sidebar must also close the
                  // profile / right panel — ProfileView takes render priority
                  // over the feed, so a stale profileEmail would keep covering
                  // the newly selected view (reported bug, 2026-08-19).
                  setProfileEmail(null);
                  setAsideOpened(false);
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
        {/* Auto unread management on/off — directly below dark mode, no separator */}
        <Group
          wrap="nowrap"
          align="center"
          justify="space-between"
          style={{ padding: "10px 12px", borderRadius: 8 }}
        >
          <Group gap="sm" wrap="nowrap" align="center">
            <span style={{ lineHeight: 1 }}>👁</span>
            <span style={{ color: "var(--text-primary)", fontSize: 14 }}>オート未読管理</span>
          </Group>
          <Switch
            checked={autoUnreadOn}
            onChange={(e) => setUnreadEnabled(e.currentTarget.checked)}
            aria-label="オート未読管理"
            size="sm"
          />
        </Group>
        {/* 自動新着通知 (Web Push) — below オート未読管理, no separator */}
        {pushSupported && (
          <Group
            wrap="nowrap"
            align="center"
            justify="space-between"
            style={{ padding: "10px 12px", borderRadius: 8 }}
          >
            <Group gap="sm" wrap="nowrap" align="center" style={{ minWidth: 0 }}>
              <span style={{ lineHeight: 1 }}>🔔</span>
              <div style={{ minWidth: 0, lineHeight: 1.3 }}>
                <div style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 500, whiteSpace: "nowrap" }}>
                  自動新着通知
                </div>
                {/iPad|iPhone|iPod/.test(navigator.userAgent) && !(window.matchMedia("(display-mode: standalone)").matches) && (
                  <div style={{ color: "var(--text-muted)", fontSize: 11 }}>iOSはホーム画面に追加が必要</div>
                )}
              </div>
            </Group>
            <Switch
              checked={pushEnabled}
              disabled={pushBusy}
              onChange={(e) => onTogglePush(e.currentTarget.checked)}
              aria-label="自動新着通知"
              size="sm"
            />
          </Group>
        )}
        {/* Account: profile + logout — moved from header to bottom of left sidebar.
            Tapping the avatar/name opens the viewer's own profile timeline. */}
        <Divider my="xs" />
        <Group wrap="nowrap" align="center" gap={10} style={{ padding: "10px 6px", borderRadius: 8 }}>
          <UnstyledButton
            display="flex"
            style={{ flex: 1, minWidth: 0, alignItems: "center", gap: 10, cursor: "pointer", textAlign: "left" }}
            onClick={() => {
              // Opening the own profile from inside the left drawer must close
              // the drawer — otherwise the menu stays open over the profile
              // (reported bug, 2026-08-19).
              setNavOpened(false);
              if (auth) openProfile(auth.email);
            }}
            aria-label="自分のプロフィールを開く"
          >
            <Avatar src={avatarSrc} alt={displayName} radius="xl" size="md" color="green">
              {displayName.charAt(0).toUpperCase()}
            </Avatar>
            <div style={{ flex: 1, minWidth: 0, lineHeight: 1.2 }}>
              <Text size="sm" fw={600} c="inherit" truncate>
                {auth.name || auth.email}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {auth.name ? auth.email : ""}
              </Text>
            </div>
          </UnstyledButton>
          <Tooltip label="ログアウト" withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={logout} aria-label="ログアウト">
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Navbar>

      {/* Right sidebar: visible only on very wide screens. Hosts the pinned-post
       *  summary cards (pins were moved here from the timeline). */}
      <AppShell.Aside data-cx="aside" p="md" style={{ background: "var(--bg-primary)", borderLeft: "1px solid var(--border-default)" }}>
        {/* offsetScrollbars: スクロールバー出現時もコンテンツがスクロールバーと重ならないよう、スクロールバー分を確保する（drikin 指摘 2026-08） */}
        <ScrollArea offsetScrollbars scrollbarSize={8}>
          <Stack pr="4" gap="sm">
          {/* Search box */}
          <Paper p="sm" radius="md" withBorder shadow="xs">
            <SearchBox
              value={searchQuery}
              onCommit={(q) => setSearchQuery(q)}
              onClear={() => setSearchQuery("")}
            />
            {searchActive && (
              <Text size="xs" c="green" mt={6}>
                「{searchQuery}」で検索中
              </Text>
            )}
          </Paper>

          {/* トレンド: 直近24hの投稿/コメントからAI抽出した検索キーワード（6時間ごと更新・タップで検索） */}
          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Group justify="space-between" align="center" mb={6} wrap="nowrap">
              <Group gap={6} align="center" wrap="nowrap">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" color="var(--text-green)" aria-hidden="true">
                  <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                  <polyline points="17 6 23 6 23 12" />
                </svg>
                <Text fw={700} size="sm">トレンド</Text>
              </Group>
            </Group>
            {trendKeywords.length === 0 ? (
              <Text size="xs" c="dimmed">トレンドキーワードはまだ生成されていません。</Text>
            ) : (
              <Stack gap={4}>
                {trendKeywords.map((t) => (
                  <UnstyledButton
                    key={t.keyword}
                    onClick={() => setSearchQuery(t.keyword)}
                    aria-label={`トレンドキーワード「${t.keyword}」で検索`}
                    style={{
                      display: "flex", alignItems: "center", gap: 8, width: "100%",
                      padding: "5px 8px", borderRadius: 8, textAlign: "left",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-subtle)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
                  >
                    <Text size="xs" fw={700} c="green" style={{ width: 16, flexShrink: 0 }}>
                      {t.rank}
                    </Text>
                    <Text size="sm" c="inherit" style={{ flex: 1, minWidth: 0 }} truncate>
                      {t.keyword}
                    </Text>
                  </UnstyledButton>
                ))}
              </Stack>
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
              <Group gap={4} wrap="nowrap" align="center">
                {notifUnread > 0 && (
                  <ActionIcon size="sm" variant="subtle" color="gray" onClick={markAllNotifRead} aria-label="すべて既読" title="すべて既読">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  </ActionIcon>
                )}
                {notifications.length > 0 && (
                  <ActionIcon size="sm" variant="subtle" color="red" onClick={clearAllNotif} aria-label="クリア" title="クリア">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 6h18" />
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </ActionIcon>
                )}
              </Group>
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
                      title="オンラインでチャット"
                      onClick={() => openChatMention(m.name || m.email)}
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
        data-cx="main"
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
        <PullToRefresh
          active={!threadPost && isCenterView && !editingPost && !deleteTarget && !linkModal.open}
          onRefresh={pullRefresh}
        />
        <div
          className="mx-auto px-3 py-4 sm:px-6 sm:py-6"
          style={{ maxWidth: 640 }}
        >
          {isCenterView && (
            <Stack gap="md">
              {/* Topmost date separator — rendered above the "+" composer so the
                  timeline opens with 日付 → プラス (feed only). TimelineFeed skips
                  its own duplicate via skipFirstDate. */}
              {activeNav === "feed" && !threadPost && !searchActive && topDateKey && (
                <Group align="center" mt="md" mb={4}>
                  <Divider style={{ flex: 1 }} />
                  <Badge
                    size="lg"
                    variant={topDateKey === jstDateKey(new Date().toISOString()) ? "filled" : "light"}
                    color={topDateKey === jstDateKey(new Date().toISOString()) ? "green" : "gray"}
                    radius="xl"
                    style={{ textTransform: "none", fontWeight: 600 }}
                  >
                    {jstDateLabel(topDateKey)}
                    {topDateKey === jstDateKey(new Date().toISOString()) ? "（今日）" : ""}
                  </Badge>
                  <Divider style={{ flex: 1 }} />
                </Group>
              )}
              {/* Composer (hidden on gallery/news? show only on home feed, and not during search).
                  Collapsed to a small "+" by default to keep the timeline clean; click expands into the full form. */}
              {activeNav === "feed" && !threadPost && !searchActive && (
                composerOpen ? (
                  <ComposerPaper
                    auth={auth}
                    avatarSrc={avatarSrc}
                    displayName={displayName}
                    mentionMembers={mentionMembers}
                    uploadImages={uploadImages}
                    uploadVideo={uploadVideo}
                    onPublish={publishComposer}
                    onClose={() => setComposerOpen(false)}
                    onPreviewImage={openPreview}
                  />
                ) : (
                  <Box style={{ display: "flex", justifyContent: "center", padding: "4px 0", lineHeight: 0 }}>
                    <UnstyledButton
                      onClick={() => setComposerOpen(true)}
                      aria-label="新しい投稿を作成"
                      title="新しい投稿を作成"
                      style={{ cursor: "pointer", padding: 2, background: "transparent", border: "none", lineHeight: 1 }}
                    >
                      <Box
                        
                    className="bguru-bark-btn"
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: "50%",
                      color: "var(--text-green-soft)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                        <BarkIcon size={20} color="#1F90FF" />
                      </Box>
                    </UnstyledButton>
                  </Box>
                )
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

              {/* Profile timeline (avatar/name click) */}
              {profileEmail ? (
                <ProfileView
                  profile={profileData}
                  posts={profilePosts}
                  loading={profileLoading}
                  hasMore={profileHasMore}
                  isOwn={!!profileData?.isSelf}
                  auth={auth}
                  avatarSrc={avatarSrc}
                  mentionMembers={mentionMembers}
                  searchQuery={searchActive ? searchQuery : undefined}
                  onClose={closeProfile}
                  onLoadMore={loadMoreProfile}
                  onEdit={openEditProfile}
                  onOpenThread={openThread}
                  onOpenThreadReply={openThreadReply}
                  onLike={handleLike}
                  onReply={openThreadReply}
                  onWhisper={toggleWhisper}
                  onEditPost={openEdit}
                  onDelete={setDeleteTarget}
                  onPin={handlePin}
                  onPreview={openPreview}
                  onOpenProfile={openProfile}
                />
              ) : feedLoading ? (
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
                          onPreview={openPreview}
                          onOpenProfile={openProfile}
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
                          onPreview={openPreview}
                          onOpenProfile={openProfile}
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
                            placeholder={`${threadPost.authorName || "この投稿"} に返信…（Shift+Enter でうなる）`}
                            value={replyText}
                            onChange={setReplyText}
                            mb="xs"
                            onPaste={(e) => {
                              const files = imagesFromPaste(e);
                              if (files) {
                                e.preventDefault();
                                onThreadReplyPick(files);
                              }
                            }}
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
                                    onClick={() => openPreview(src, threadReplyImages)}
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
                          {threadReplyVideo && (
                            <Box mb="xs" style={{ position: "relative", width: "100%", maxWidth: 320 }}>
                              <video
                                src={threadReplyVideo}
                                controls
                                playsInline
                                preload="metadata"
                                style={{ width: "100%", display: "block", borderRadius: 8, background: "#000" }}
                              />
                              <ActionIcon
                                size="sm"
                                variant="filled"
                                color="red"
                                radius="xl"
                                style={{ position: "absolute", top: -6, right: -6 }}
                                onClick={removeThreadReplyVideo}
                              >
                                ×
                              </ActionIcon>
                            </Box>
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
                            <label style={{ cursor: "pointer", display: "inline-block" }}>
                              <input
                                type="file"
                                accept="video/mp4,video/webm,video/quicktime"
                                hidden
                                onChange={(e) => {
                                  onThreadReplyPickVideo(e.target.files);
                                  e.target.value = "";
                                }}
                              />
                              <Button
                                size="xs"
                                variant="light"
                                color="gray"
                                component="span"
                                loading={threadVideoUploading}
                                disabled={!!threadReplyVideo}
                              >
                                🎬 動画
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
                                  setThreadReplyVideo(null);
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
                                  disabled={(replyText.trim() === "" && threadReplyImages.length === 0 && !threadReplyVideo) || replying !== false}
                                  onClick={() => submitThreadReply(true)}
                                >
                                  うなる
                                </Button>
                                <Button
                                  size="xs"
                                  color="green"
                                  loading={replying === 'comment'}
                                  disabled={(!replyText.trim() && threadReplyImages.length === 0 && !threadReplyVideo) || replying !== false}
                                  type="submit"
                                >
                                  吠える
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
                  skipFirstDate={
                    activeNav === "feed" && !threadPost && !searchActive && !!topDateKey
                  }
                  auth={auth}
                  avatarSrc={avatarSrc}
                  mentionMembers={mentionMembers}
                  searchQuery={searchActive ? searchQuery : undefined}
                  inlineReplyFor={inlineReplyFor}
                  uploadImages={uploadImages}
                  uploadVideo={uploadVideo}
                  onToggleInlineReply={toggleInlineReply}
                  onInlineReplySubmit={submitInlineReply}
                  onOpenThread={openThread}
                  onOpenThreadReply={openThreadReply}
                  onLike={handleLike}
                  onReply={openThreadReply}
                  onWhisper={toggleWhisper}
                  onEdit={openEdit}
                  onDelete={setDeleteTarget}
                  onPin={handlePin}
                  onPreview={openPreview}
                  onOpenProfile={openProfile}
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

      {/* Full-screen image lightbox (arrow keys / swipe switch images, pinch zoom & pan) */}
      {previewImage && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 9999,
            background: "rgba(0,0,0,0.94)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            touchAction: "none",
            userSelect: "none",
            WebkitUserSelect: "none",
            padding: 0,
            margin: 0,
          }}
          onPointerDown={(e) => {
            try {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            } catch {}
            const x = e.clientX;
            const y = e.clientY;
            lbPointers.current.set(e.pointerId, { x, y });
            const g = lbGesture.current;
            if (lbPointers.current.size === 2) {
              const pts = [...lbPointers.current.values()];
              g.startDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
              g.startScale = previewScale;
              g.mode = "pinch";
            } else {
              g.startX = x;
              g.startY = y;
              g.startT = Date.now();
              g.startPan = previewPan;
              g.mode = previewScale > 1 ? "pan" : "tap";
            }
          }}
          onPointerMove={(e) => {
            const g = lbGesture.current;
            const prev = lbPointers.current.get(e.pointerId);
            if (!prev) return;
            const x = e.clientX;
            const y = e.clientY;
            lbPointers.current.set(e.pointerId, { x, y });
            if (g.mode === "pinch" && lbPointers.current.size === 2) {
              const pts = [...lbPointers.current.values()];
              const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
              const ns = Math.min(6, Math.max(1, (g.startScale * dist) / g.startDist));
              setPreviewScale(ns);
            } else if (g.mode === "pan") {
              setPreviewPan({
                x: g.startPan.x + (x - g.startX),
                y: g.startPan.y + (y - g.startY),
              });
            }
          }}
          onPointerUp={(e) => {
            const g = lbGesture.current;
            const pt = lbPointers.current.get(e.pointerId);
            lbPointers.current.delete(e.pointerId);
            if (lbPointers.current.size === 0) {
              const dx = pt ? e.clientX - g.startX : 0;
              const dy = pt ? e.clientY - g.startY : 0;
              const dt = Date.now() - g.startT;
              if (g.mode === "tap") {
                if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) && dt < 400) {
                  navigatePreview(dx < 0 ? 1 : -1);
                } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 && dt < 350) {
                  setPreviewImage(null);
                }
              }
              if (g.mode === "pan") {
                const maxX = Math.max(0, ((previewScale - 1) * window.innerWidth) / 2);
                const maxY = Math.max(0, ((previewScale - 1) * window.innerHeight) / 2);
                setPreviewPan((p) => ({
                  x: Math.max(-maxX, Math.min(maxX, p.x)),
                  y: Math.max(-maxY, Math.min(maxY, p.y)),
                }));
              }
              if (g.mode === "pinch" && previewScale <= 1) setPreviewPan({ x: 0, y: 0 });
            }
            if (g.mode !== "pinch" && lbPointers.current.size < 2) g.mode = "none";
          }}
          onPointerCancel={() => {
            lbPointers.current.clear();
            lbGesture.current.mode = "none";
          }}
        >
          {/* Close button */}
          <div
            onPointerDown={(e) => e.stopPropagation()}
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

          {/* Image counter */}
          {previewImages.length > 1 && (() => {
            const idx = previewImages.indexOf(previewImage);
            return (
              <div
                style={{
                  position: "fixed",
                  top: 22,
                  left: "50%",
                  transform: "translateX(-50%)",
                  zIndex: 10000,
                  color: "rgba(255,255,255,0.85)",
                  fontSize: 14,
                  pointerEvents: "none",
                  userSelect: "none",
                }}
              >
                {idx + 1} / {previewImages.length}
              </div>
            );
          })()}

          <img
            src={previewImage}
            alt="プレビュー"
            draggable={false}
            onDoubleClick={() => {
              if (previewScale > 1) {
                setPreviewScale(1);
                setPreviewPan({ x: 0, y: 0 });
              } else {
                setPreviewScale(2.5);
                setPreviewPan({ x: 0, y: 0 });
              }
            }}
            onWheel={(e) => {
              e.preventDefault();
              const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
              setPreviewScale((s) => Math.min(6, Math.max(1, s * factor)));
            }}
            style={{
              maxWidth: "100vw",
              maxHeight: "100vh",
              width: "auto",
              height: "auto",
              objectFit: "contain",
              display: "block",
              userSelect: "none",
              WebkitUserSelect: "none",
              transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewScale})`,
              transition: lbPointers.current.size > 0 ? "none" : "transform 0.18s ease",
              cursor: previewScale > 1 ? "grab" : "zoom-in",
            }}
          />

          {/* Prev / next buttons (shown when a group of images is open) */}
          {previewImages.length > 1 && (
            <>
              <button
                aria-label="前の画像"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  navigatePreview(-1);
                }}
                style={{
                  position: "fixed",
                  left: 14,
                  top: "50%",
                  transform: "translateY(-50%)",
                  zIndex: 10000,
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.14)",
                  color: "#fff",
                  border: "none",
                  fontSize: 30,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  userSelect: "none",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
                }}
              >
                ‹
              </button>
              <button
                aria-label="次の画像"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  navigatePreview(1);
                }}
                style={{
                  position: "fixed",
                  right: 14,
                  top: "50%",
                  transform: "translateY(-50%)",
                  zIndex: 10000,
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
                  background: "rgba(255,255,255,0.14)",
                  color: "#fff",
                  border: "none",
                  fontSize: 30,
                  lineHeight: 1,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  userSelect: "none",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.3)",
                }}
              >
                ›
              </button>
            </>
          )}
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
              onPaste={(e) => {
                const files = imagesFromPaste(e);
                if (files) {
                  e.preventDefault();
                  onEditPickImages(files);
                }
              }}
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
                      onClick={() => openPreview(src, editImages)}
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

      {/* Profile edit modal (own profile only) */}
      <Modal
        opened={editingProfile}
        onClose={() => setEditingProfile(false)}
        centered={!kbOpen}
        withCloseButton
        title="プロフィールを編集"
      >
        {/* An explicit form with a no-op submit handler so the Enter key never
         * triggers Mantine Modal's implicit-submit behavior (which unmounts the
         * modal and loses the user's input, or navigates). */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
          }}
        >
          <Stack gap="sm">
          <TextInput
            label="表示名"
            value={profileForm.displayName}
            onChange={(e) => setProfileForm((f) => ({ ...f, displayName: e.currentTarget.value }))}
            placeholder="タイムラインに表示する名前（未設定なら投稿名）"
          />
          <Textarea
            label="自己紹介"
            value={profileForm.bio}
            onChange={(e) => setProfileForm((f) => ({ ...f, bio: e.currentTarget.value }))}
            minRows={3}
            placeholder="自己紹介（Markdown 可）"
          />
          <Box>
            <Text size="xs" c="dimmed" mb={4}>
              ヘッダー画像
            </Text>
            <Group gap="xs">
              {profileForm.headerImage ? (
                <Image src={profileForm.headerImage} width={150} height={70} fit="cover" radius="md" />
              ) : null}
              <Button
                size="xs"
                variant="light"
                color="gray"
                loading={profileUploading}
                disabled={profileUploading}
                onClick={() => profileHeaderRef.current?.click()}
              >
                {profileForm.headerImage ? "ヘッダー画像を変更" : "ヘッダー画像を追加"}
              </Button>
              {profileForm.headerImage ? (
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() => setProfileForm((f) => ({ ...f, headerImage: "" }))}
                >
                  解除
                </Button>
              ) : null}
            </Group>
            <input
              ref={profileHeaderRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => onProfileHeaderPick(e.currentTarget.files)}
            />
          </Box>
          <Box>
            <Text size="xs" c="dimmed" mb={4}>
              関連リンク
            </Text>
            <Stack gap={6}>
              {profileLinks.map((l, i) => (
                <Group key={i} gap="xs" align="center" wrap="nowrap">
                  <TextInput
                    placeholder="名前（例: X / ブログ）"
                    value={l.label}
                    style={{ flex: 1 }}
                    onKeyDown={(e) => {
                      // Never let Enter in a link field commit the modal /
                      // trigger any form-submit navigation (which would reload
                      // the page at the current #/user/<email> URL).
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                    onChange={(e) => {
                      // Capture the value BEFORE the functional updater: React runs
                      // updaters on the next render, by which time e.currentTarget
                      // is null. Reading it inside the updater throws a TypeError
                      // that crashes/unmounts the modal (the "link can't be set" bug).
                      const v = e.currentTarget.value;
                      setProfileLinks((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, label: v } : x))
                      );
                    }}
                  />
                  <TextInput
                    placeholder="https://…"
                    value={l.href}
                    style={{ flex: 2 }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                      }
                    }}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setProfileLinks((prev) =>
                        prev.map((x, j) => (j === i ? { ...x, href: v } : x))
                      );
                    }}
                  />
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() => setProfileLinks((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </ActionIcon>
                </Group>
              ))}
            </Stack>
            <Button
              size="xs"
              variant="subtle"
              color="green"
              mt={6}
              onClick={() => setProfileLinks((p) => [...p, { label: "", href: "" }])}
            >
              + リンクを追加
            </Button>
          </Box>
          {actionError && (
            <Text size="xs" c="red">
              {actionError}
            </Text>
          )}
          <Group justify="flex-end" mt="xs">
            <Button size="xs" variant="subtle" color="gray" onClick={() => setEditingProfile(false)}>
              キャンセル
            </Button>
            <Button size="xs" color="green" loading={profileSaving} onClick={saveProfile}>
              保存
            </Button>
          </Group>
          </Stack>
        </form>
      </Modal>

      {/* Header-image banner crop modal */}
      <Modal
        opened={cropModalOpen}
        onClose={() => {
          if (profileUploading) return;
          setCropModalOpen(false);
          setCropSource((cs) => {
            if (cs) URL.revokeObjectURL(cs.url);
            return null;
          });
        }}
        centered={!kbOpen}
        withCloseButton
        title="ヘッダー画像をクロップ"
        size="md"
      >
        {cropSource ? (
          <BannerCropper
            src={cropSource.url}
            uploading={profileUploading}
            onApply={onBannerApply}
            onCancel={() => {
              setCropModalOpen(false);
              setCropSource((cs) => {
                if (cs) URL.revokeObjectURL(cs.url);
                return null;
              });
            }}
          />
        ) : null}
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
            onChange={(e) => {
              const v = e.currentTarget.value;
              setLinkModal((m) => ({ ...m, label: v }));
            }}
            placeholder="例: ネタ帳"
          />
          <TextInput
            label="URL"
            value={linkModal.href}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setLinkModal((m) => ({ ...m, href: v }));
            }}
            placeholder="https://..."
          />
          <TextInput
            label="アイコン（絵文字）"
            value={linkModal.icon}
            onChange={(e) => {
              const v = e.currentTarget.value;
              setLinkModal((m) => ({ ...m, icon: v }));
            }}
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

      {/* Realtime chat widget — bottom-right bubble that opens a mini chat
          window for the global room (replaces the old wave 👋 feature).
          Hidden while the edit modal is open so the fixed bubble (bottom-right,
          zIndex 2900) doesn't overlap the modal's 保存 button on mobile. */}
      {!editingPost && !(inputFocused && !chatOpen) && (chatOpen ? (
        <Paper
          radius="lg"
          withBorder
          shadow="xl"
          style={{
            position: "fixed",
            right: 24,
            bottom: 20,
            zIndex: 2900,
            width: 340,
            maxWidth: "calc(100vw - 32px)",
            height: 440,
            maxHeight: "calc(100vh - 48px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            background: "var(--bg-surface)",
            borderColor: "var(--border-green)",
          }}
        >
          {/* Header */}
          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            p="xs"
            style={{
              borderBottom: "1px solid var(--border-green)",
              background: "var(--bg-subtle)",
              flexShrink: 0,
            }}
          >
            <Group gap={6} align="center" wrap="nowrap">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="currentColor"
                stroke="none"
                color="var(--text-green)"
                aria-hidden="true"
              >
                <circle cx="12" cy="12" r="5" />
              </svg>
              <Text fw={700} size="sm">
                ビーグルチャット
              </Text>
              <Text size="xs" c="dimmed">
                {onlineMembers.length > 0
                  ? `${onlineMembers.length}人在線`
                  : "オフライン"}
              </Text>
            </Group>
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={closeChat}
              aria-label="チャットを閉じる"
            >
              <svg
                width="16"
                height="16"
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

          {/* Message list */}
          <ScrollArea.Autosize
            type="auto"
            scrollbarSize={8}
            offsetScrollbars
            style={{ flex: 1, minHeight: 0 }}
            viewportRef={chatListRef}
          >
            <div
              style={{
                padding: "8px 10px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {chatMessages.length === 0 ? (
                <Text size="sm" c="dimmed" ta="center" py="lg">
                  まだメッセージはありません。さっそく話しかけてみましょう。
                </Text>
              ) : (
                chatMessages.map((m) => {
                  const mine = !!auth && m.authorEmail === auth.email;
                  return (
                    <div
                      key={m.id}
                      style={{
                        display: "flex",
                        justifyContent: mine ? "flex-end" : "flex-start",
                      }}
                    >
                      <div
                        style={{
                          maxWidth: "82%",
                          display: "flex",
                          flexDirection: "column",
                          alignItems: mine ? "flex-end" : "flex-start",
                        }}
                      >
                        {!mine && (
                          <Group
                            gap={5}
                            align="center"
                            wrap="nowrap"
                            mb={2}
                          >
                            <SafeAvatar
                              src={m.avatar}
                              initial={m.authorName || m.authorEmail}
                              size="xs"
                            />
                            <Text size="xs" c="dimmed">
                              {m.authorName || m.authorEmail}
                            </Text>
                          </Group>
                        )}
                        <div
                          style={{
                            background: mine
                              ? "var(--bg-surface)"
                              : "var(--bg-subtle)",
                            border: mine
                              ? "1px solid var(--border-green)"
                              : "1px solid transparent",
                            borderRadius: mine
                              ? "14px 14px 2px 14px"
                              : "14px 14px 14px 2px",
                            padding: "6px 10px",
                            fontSize: 13,
                            lineHeight: 1.45,
                            whiteSpace: "pre-wrap",
                            wordBreak: "break-word",
                          }}
                        >
                        {renderChatBody(m.body, mentionMembers, auth?.email || "")}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea.Autosize>

          {/* Composer */}
          <Group
            align="flex-end"
            gap={8}
            wrap="nowrap"
            p="xs"
            style={{ borderTop: "1px solid var(--border-green)", flexShrink: 0 }}
          >
            <MentionTextarea
              value={chatText}
              onChange={(v) => setChatText(v)}
              initialMention={chatMention}
              onKeyDown={(e) => {
                if ((e.nativeEvent as any).isComposing) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendChat();
                }
              }}
              placeholder="メッセージ（@名前 でメンション・Enter 送信）"
              autosize
              minRows={1}
              maxRows={4}
              suggestUp
              wrapperStyle={{ flex: 1 }}
              ariaLabel="チャットメッセージ"
            />
            <ActionIcon
              variant="filled"
              color="green"
              size="md"
              onClick={sendChat}
              disabled={chatSending || !chatText.trim()}
              aria-label="送信"
              style={{ flexShrink: 0, marginBottom: 4 }}
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
                <path d="m22 2-7 20-4-9-9-4Z" />
                <path d="M22 2 11 13" />
              </svg>
            </ActionIcon>
          </Group>
        </Paper>
      ) : (
        <div style={{ position: "fixed", right: 24, bottom: 20, zIndex: 2900 }}>
          <UnstyledButton
            onClick={openChat}
            aria-label="チャットを開く"
            title="ビーグルチャットを開く"
            style={{
              width: 56,
              height: 56,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              background: "transparent",
              border: "none",
              padding: 0,
              position: "relative",
              filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.32)) drop-shadow(0 1px 2px rgba(0,0,0,0.18))",
            }}
          >
            <img
              src="/icon-chat.png"
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "contain" }}
            />
          </UnstyledButton>
          {chatUnread > 0 && (
            <div
              style={{
                position: "absolute",
                top: -4,
                right: -4,
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                padding: "0 5px",
                background: "#e03131",
                color: "#fff",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: "18px",
                textAlign: "center",
                boxShadow: "0 1px 3px rgba(0,0,0,.3)",
                pointerEvents: "none",
              }}
            >
              {chatUnread > 99 ? "99+" : chatUnread}
            </div>
          )}
        </div>
      ))}

      {/* Beagle bark: when the chat window is closed and someone @mentions the
          current user, the beagle icon barks in the center of the screen for
          extra attention (on top of the unread badge below). Remounts on each
          new mention via `key={barkKey}` so the CSS animation restarts. */}
      {barkKey > 0 && (
        <div key={barkKey} className="bguru-bark-overlay" aria-hidden="true">
          <div className="bguru-bark-ring" style={{ animationDelay: "0.00s" }} />
          <div className="bguru-bark-ring" style={{ animationDelay: "0.18s" }} />
          <div className="bguru-bark-ring" style={{ animationDelay: "0.36s" }} />
          <div className="bguru-bark-beagle">
            <img src="/icon-chat.png" alt="" draggable={false} />
            <span className="bguru-bark-woof">ワン！</span>
          </div>
          {barkFrom && (
            <div className="bguru-bark-caption">
              {barkFrom} さんがあなたに吠えました
            </div>
          )}
        </div>
      )}

      {/* TEMP diagnostic: client JS error badge (bottom-left). Remove with the
          GlobalError listeners above after root cause is found. */}
      {clientErr && (
        <div
          onClick={() => setClientErr(null)}
          title="クリックで閉じる（一時診断用）"
          style={{
            position: "fixed",
            left: 12,
            bottom: 12,
            zIndex: 9999,
            maxWidth: "72vw",
            background: "#c0392b",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 12,
            lineHeight: 1.4,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            cursor: "pointer",
            boxShadow: "0 2px 10px rgba(0,0,0,.35)",
            pointerEvents: "auto",
          }}
        >
          <b>JSエラー:</b> {clientErr.msg}{" "}
          <span style={{ opacity: 0.75 }}>({clientErr.at})</span>
        </div>
      )}
          <style>{`
        .bguru-bark-btn {
          background: var(--bg-surface);
          border: 1px solid var(--border-green);
          box-shadow: 0 2px 4px rgba(0,0,0,0.18);
          transition: box-shadow 0.12s ease, transform 0.08s ease;
        }
        .bguru-bark-btn:hover {
          box-shadow: 0 3px 7px rgba(0,0,0,0.26);
        }
        .bguru-bark-btn:active {
          transform: translateY(1px);
          box-shadow: 0 1px 2px rgba(0,0,0,0.16);
        }
        /* Beagle "bark" overlay — the bubble icon barks in the center of the
           screen when the user is @mentioned while the chat is closed. */
        .bguru-bark-overlay {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          z-index: 3200;
          pointer-events: none;
          animation: bguruBarkFade 2.6s ease forwards;
        }
        @keyframes bguruBarkFade {
          0%, 68% { opacity: 1; }
          100% { opacity: 0; }
        }
        .bguru-bark-beagle {
          position: relative;
          width: 96px;
          height: 96px;
          animation: bguruBarkBounce 0.9s cubic-bezier(.18,.89,.32,1.2) both;
        }
        .bguru-bark-beagle img {
          width: 100%;
          height: 100%;
          object-fit: contain;
          filter: drop-shadow(0 5px 12px rgba(0,0,0,0.32));
        }
        @keyframes bguruBarkBounce {
          0% { transform: scale(0); opacity: 0; }
          40% { transform: scale(1.18); opacity: 1; }
          62% { transform: scale(0.96); }
          80% { transform: scale(1.04); }
          100% { transform: scale(1); }
        }
        .bguru-bark-woof {
          position: absolute;
          top: -34px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 21px;
          font-weight: 800;
          color: #1F90FF;
          white-space: nowrap;
          text-shadow: 0 2px 6px rgba(255,255,255,0.92);
        }
        .bguru-bark-ring {
          position: absolute;
          width: 120px;
          height: 120px;
          border-radius: 50%;
          border: 3px solid rgba(31,144,255,0.65);
          opacity: 0;
          animation: bguruBarkRing 1.5s ease-out forwards;
        }
        @keyframes bguruBarkRing {
          0% { transform: scale(0.4); opacity: 0.95; }
          100% { transform: scale(2.6); opacity: 0; }
        }
        .bguru-bark-caption {
          margin-top: 14px;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-body);
          background: var(--bg-surface);
          border: 1px solid var(--border-green);
          padding: 6px 12px;
          border-radius: 999px;
          box-shadow: 0 2px 8px rgba(0,0,0,0.12);
        }
      `}</style>
</AppShell>
  );
}
