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
} from "@mantine/core";

interface Episode {
  id: string;
  title: string;
  slug: string;
  publishedAt: string;
  visibility: string;
  tags: string[];
  canonicalUrl?: string;
  pageUrl?: string;
  excerpt?: string;
}

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
      // Pinned posts float to the very top (expired pins arrive as pinnedAt=null
      // so they fall into the normal order). Among pinned, the oldest-pinned
      // comes first; the rest follow by latest activity.
      const ap = a.posts[0].pinnedAt ? 1 : 0;
      const bp = b.posts[0].pinnedAt ? 1 : 0;
      if (ap !== bp) return bp - ap;
      if (a.posts[0].pinnedAt && b.posts[0].pinnedAt) {
        return a.posts[0].pinnedAt < b.posts[0].pinnedAt
          ? -1
          : a.posts[0].pinnedAt > b.posts[0].pinnedAt
          ? 1
          : 0;
      }
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
  comment: string;
  createdAt: string;
}

const NAV_ITEMS: {
  key: string;
  label: string;
  icon: string;
  href?: string;
  external?: boolean;
}[] = [
  { key: "feed", label: "ホーム", icon: "🏠" },
  { key: "episodes", label: "エピソード", icon: "🎧" },
  { key: "gallery", label: "ギャラリー", icon: "🖼️" },
  { key: "news", label: "記事", icon: "📰" },
  { key: "drinews", label: "ドリニュース", icon: "📮" },
  { key: "dvlog", label: "デスブロ", icon: "📺", href: "https://dvlog.jp/", external: true },
  { key: "neta", label: "ネタ帳", icon: "🗒️", href: "https://neta.backspace.fm/", external: true },
];

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
    <Badge
      size="sm"
      variant="light"
      color="green"
      radius="xl"
      style={{ fontWeight: 600, textTransform: "none" }}
    >
      ピン 残り {pad(h)}:{pad(m)}:{pad(s)}
    </Badge>
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
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
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
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number, name: string) => void;
  onPin: (id: number) => void;
  onEdit: (post: FeedPost) => void;
  onDelete: (post: FeedPost) => void;
  onPreview: (src: string) => void;
}) {
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
      {/* Pinned banner — only on pinned ROOT posts */}
      {!!post.pinnedAt && !post.parentId && (
        <Box
          mb="xs"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            background: "#eaf7ec",
            border: "1px solid #cde6cd",
            borderRadius: 8,
            padding: "4px 10px",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
            <path d="M12 17v5" />
            <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
          </svg>
          <Text size="xs" fw={600} c="green.8">
            タイムライン最上部にピン中
            <span style={{ fontVariantNumeric: "tabular-nums", marginLeft: 6 }}>
              <PinCountdown pinnedAt={post.pinnedAt} />
            </span>
          </Text>
        </Box>
      )}

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
          <Text size="sm" fw={600} c="dark">
            {post.authorName || post.authorEmail.split("@")[0]}
          </Text>
          <Text size="xs" c="dimmed">
            {formatJSTPDT(post.createdAt)}
          </Text>
        </div>
      </Group>

      {post.text && (
        <Text size="sm" c="dark" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {post.text}
        </Text>
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
                      color: "#fff",
                    }}
                  >
                    ▶
                  </Box>
                </Box>
              )}
            </Box>
          )}
          <Text size="sm" fw={600} c="dark">
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

      {/* Only reply remains as a bottom action (like removed). Edit/delete are
       *  now the small icons in the card's top-right corner. */}
      {showReplyButton && (
        <Group mt="sm">
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

/** Grouped timeline: day separators + per-author groups. Posts are shown fully
 *  expanded (no collapse/stack) inside a group framed by a slim author header. */
function TimelineFeed({
  groups,
  auth,
  avatarSrc,
  inlineReplyFor,
  inlineReplyText,
  onInlineReplyChange,
  onToggleInlineReply,
  onInlineReplySubmit,
  onOpenThread,
  onOpenThreadReply,
  onLike,
  onReply,
  onEdit,
  onDelete,
  onPin,
  onPreview,
}: {
  groups: FeedGroup[];
  auth: { email: string };
  avatarSrc?: string | null;
  inlineReplyFor: number | null;
  inlineReplyText: string;
  onInlineReplyChange: (t: string) => void;
  onToggleInlineReply: (id: number) => void;
  onInlineReplySubmit: (id: number) => void;
  onOpenThread: (id: number) => void;
  onOpenThreadReply: (id: number) => void;
  onLike: (id: number) => void;
  onReply: (id: number) => void;
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
        style={{
          borderLeft: "3px solid #cde6cd",
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
            {/* The author's own card (no reply button here; "+" below adds feedback) */}
            <PostCard
              post={post}
              auth={auth}
              avatarSrc={avatarSrc}
              isThreadRoot={false}
              showReplyButton={false}
              onOpenThread={onOpenThread}
              onOpenThreadReply={onOpenThreadReply}
              onLike={onLike}
              onReply={onReply}
              onEdit={onEdit}
              onDelete={onDelete}
              onPin={onPin}
              onPreview={onPreview}
            />
            {/* Interleaved comments = replies to this card, rendered right after
             * it so the position (between which cards) is preserved. */}
            {(post.replies ?? []).map((rep) => (
              <Box
                key={`rep-${rep.id}`}
                ml={6}
                style={{
                  borderLeft: "2px solid #e0ecd0",
                  paddingLeft: 8,
                  background: "#fbfcf8",
                  borderRadius: 8,
                }}
              >
                <PostCard
                  post={rep}
                  auth={auth}
                  avatarSrc={avatarSrc}
                  isThreadRoot={false}
                  showReplyButton={false}
                  onOpenThread={onOpenThread}
                  onOpenThreadReply={() => {}}
                  onLike={onLike}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onPin={onPin}
                  onPreview={onPreview}
                />
              </Box>
            ))}
            {/* "+" insert control: a small circular button centered in a slim row
             * between cards. Center placement is intuitive ("insert here"),
             * while the single narrow row keeps vertical space tight. */}
            {inlineReplyFor === post.id ? (
              <Stack
                gap={6}
                p="xs"
                style={{ background: "#f6f9f4", borderRadius: 8, border: "1px solid #e0ecd0" }}
              >
                <Textarea
                  value={inlineReplyText}
                  autoFocus
                  onChange={(e) => onInlineReplyChange(e.currentTarget.value)}
                  placeholder={`${g.authorName || g.authorEmail.split("@")[0]} の投稿にコメント…`}
                  minRows={2}
                  autosize
                  maxRows={5}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      if ((e.nativeEvent as any).isComposing) return;
                      e.preventDefault();
                      onInlineReplySubmit(post.id);
                    }
                  }}
                />
                <Group justify="flex-end" gap="xs">
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => onToggleInlineReply(post.id)}
                  >
                    キャンセル
                  </Button>
                  <Button size="xs" onClick={() => onInlineReplySubmit(post.id)}>
                    コメント
                  </Button>
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
                      border: "1px solid #bfd8bf",
                      color: "#4a9d4a",
                      background: "#ffffff",
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

export default function Home() {
  const [auth, setAuth] = useState<null | {
    email: string;
    name?: string | null;
    avatar?: string | null;
  }>(null);
  const [checking, setChecking] = useState(true);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [epLoading, setEpLoading] = useState(true);

  const [view, setView] = useState<View>("login");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const [activeNav, setActiveNav] = useState("feed");
  const [navOpened, setNavOpened] = useState(false);

  // ---- Feed state ----
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);
  const [feedHasMore, setFeedHasMore] = useState(true);
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
  const [replying, setReplying] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const [threadPost, setThreadPost] = useState<FeedPost | null>(null);
  const [threadReplies, setThreadReplies] = useState<FeedPost[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadReplyBoxOpen, setThreadReplyBoxOpen] = useState(false);
  // Inline "insert between cards" reply state (timeline group comments).
  const [inlineReplyFor, setInlineReplyFor] = useState<number | null>(null);
  const [inlineReplyText, setInlineReplyText] = useState("");
  const [inlineReplying, setInlineReplying] = useState(false);

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
  const [notifOpen, setNotifOpen] = useState(false);

  const displayName = auth?.name || auth?.email?.split("@")[0] || "";
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
      setEpLoading(false);
      setFeedLoading(false);
      return;
    }
    loadEpisodes();
    loadFeed();
    loadNotifications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth]);

  const loadEpisodes = () => {
    fetch("/api/episodes")
      .then((r) => r.json())
      .then((d) => setEpisodes(d.episodes ?? []))
      .catch(() => setEpisodes([]))
      .finally(() => setEpLoading(false));
  };

  const FEED_PAGE = 50;

  const loadFeed = (filter?: string) => {
    setFeedLoading(true);
    setFeedHasMore(true);
    feedCursorRef.current = null;
    const q = `?limit=${FEED_PAGE}${filter ? `&filter=${filter}` : ""}`;
    fetch(`/api/posts${q}`)
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
    const q = `?limit=${FEED_PAGE}&before=${encodeURIComponent(feedCursorRef.current)}${
      filter ? `&filter=${filter}` : ""
    }`;
    fetch(`/api/posts${q}`)
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

  const toggleNotifOpen = (open: boolean) => {
    setNotifOpen(open);
    if (open) loadNotifications();
  };

  // Mark a single notification read (clicking a reply)
  const handleNotifClick = (n: any) => {
    setNotifOpen(false); // close the popover first
    setActiveNav("feed"); // make sure the thread view can render
    if (!n.readAt) {
      fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: n.id }),
      }).then(() => {
        loadNotifications();
        if (n.postId) openThread(n.postId);
      });
    } else if (n.postId) {
      openThread(n.postId);
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

  // Load filtered feed when switching views
  useEffect(() => {
    if (!auth) return;
    if (activeNav === "gallery") loadFeed("images");
    else if (activeNav === "news") loadFeed("links");
    else if (activeNav === "episodes") loadFeed("episodes");
    else if (activeNav === "feed") loadFeed();
  }, [activeNav, auth]);

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
    setEpisodes([]);
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

  const onPickImages = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const usable = Array.from(files).slice(0, Math.max(0, 5 - pendingImages.length));
    if (usable.length === 0) return;
    setUploading(true);
    setPostError(null);
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
      setPendingImages((prev) => [...prev, ...d.urls]);
    } catch (err: any) {
      setPostError(err.message);
    } finally {
      setUploading(false);
    }
  };

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
        loadFeed();
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
    setReplyError(null);
    openThread(postId);
    setThreadReplyBoxOpen(true);
  };

  // Submit a reply from within the thread view
  const submitThreadReply = async () => {
    if (!threadPost || replying) return;
    const text = replyText.trim();
    if (!text) return;
    setReplying(true);
    setReplyError(null);
    try {
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images: [], parentId: threadPost.id }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "返信失敗");
      setReplyText("");
      setReplyError(null);
      openThread(threadPost.id); // reload
      loadFeed(); // refresh reply counters on timeline
    } catch (err: any) {
      setReplyError(err.message);
    } finally {
      setReplying(false);
    }
  };

  // ---- Inline "insert between cards" comment (timeline group) ----
  const toggleInlineReply = (postId: number) => {
    setInlineReplyFor((prev) => (prev === postId ? null : postId));
    setInlineReplyText("");
  };
  const submitInlineReply = async (postId: number) => {
    const text = inlineReplyText.trim();
    if (!text || inlineReplying) return;
    setInlineReplying(true);
    try {
      const r = await fetch("/api/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images: [], parentId: postId }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "コメント失敗");
      setInlineReplyFor(null);
      setInlineReplyText("");
      loadFeed(); // re-render so the comment appears inline in the group
    } catch (err: any) {
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
    setThreadReplyBoxOpen(false);
    setReplyError(null);
    // Allow the browser back button to close the thread view.
    window.history.pushState({ thread: postId }, "", `#/post/${postId}`);
    fetch(`/api/posts/${postId}`)
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
      loadFeed(); // refresh reply counts on timeline
    }
  };

  // Return to the top/home (feed) view from anywhere — including from a thread.
  const goHome = () => {
    setActiveNav("feed");
    setThreadPost(null);
    setThreadReplies([]);
    setInlineReplyFor(null);
    setNotifOpen(false);
    setNavOpened(false);
    if (window.location.hash.startsWith("#/post/")) {
      // Replace the hash so we don't leave the thread in history.
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        // ignore
      }
    }
    loadFeed();
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

  // Pin / unpin own post (24h top placement). Reload the feed so the new pin
  // order (and any same-author pin swap) is reflected.
  const handlePin = (postId: number) => {
    fetch(`/api/posts/${postId}/pin`, { method: "POST" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "ピン更新失敗");
        loadFeed();
      })
      .catch((err) => setActionError(err.message));
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

  const saveEdit = () => {
    if (!editingPost || savingEdit) return;
    setSavingEdit(true);
    setActionError(null);
    fetch(`/api/posts/${editingPost.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: editText.trim(), images: editImages }),
    })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "更新失敗");
        setEditingPost(null);
        loadFeed();
      })
      .catch((err) => setActionError(err.message))
      .finally(() => setSavingEdit(false));
  };

  // Delete post
  const confirmDelete = () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setActionError(null);
    fetch(`/api/posts/${deleteTarget.id}`, { method: "DELETE" })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || "削除失敗");
        setDeleteTarget(null);
        loadFeed();
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
      <main className="flex-1 w-full min-h-screen flex items-center justify-center bg-gray-50">
        <Text c="dimmed">読み込み中…</Text>
      </main>
    );
  }

  if (!auth) {
    return (
      <main className="flex-1 w-full max-w-md mx-auto px-6 py-16 bg-gray-50">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-400 font-black text-2xl text-white shadow-lg mb-5">
            B
          </div>
          <Title order={1} fw={900} c="dark">
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
      aside={{ width: 280, breakpoint: "lg", collapsed: { mobile: true } }}
      padding={0}
    >
      {/* Header */}
      <AppShell.Header style={{ background: "#ffffff", borderBottom: "1px solid #e5e7eb" }}>
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
              color="dark"
            />
          </Group>
          {/* Center: site logo (blue leaping dog) */}
          <UnstyledButton
            onClick={goHome}
            aria-label="ホームへ戻る"
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
                <Text size="sm" fw={600} c="dark">
                  {auth.name || auth.email}
                </Text>
                <Text size="xs" c="dimmed">
                  {auth.name ? auth.email : ""}
                </Text>
              </div>
            </Group>
            <Tooltip label="通知" withArrow>
              <Popover
                opened={notifOpen}
                onClose={() => setNotifOpen(false)}
                position="bottom-end"
                width={340}
                withArrow
                withinPortal
                styles={{ dropdown: { width: "min(340px, 92vw)" } }}
              >
                <Popover.Target>
                  <Indicator
                    inline
                    size={16}
                    offset={4}
                    color="red"
                    label={notifUnread > 9 ? "9+" : notifUnread}
                    disabled={notifUnread === 0}
                  >
                    <ActionIcon
                      variant="subtle"
                      color="dark"
                      radius="xl"
                      size="lg"
                      onClick={() => toggleNotifOpen(!notifOpen)}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                        <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
                      </svg>
                    </ActionIcon>
                  </Indicator>
                </Popover.Target>
                <Popover.Dropdown p={0} style={{ border: "1px solid #e5e7eb", borderRadius: 12 }}>
                  <Box>
                    <Group justify="space-between" p="sm" style={{ borderBottom: "1px solid #e5e7eb" }}>
                      <Text fw={700} size="sm" c="dark">
                        通知
                      </Text>
                      {notifUnread > 0 && (
                        <Button size="xs" variant="subtle" color="gray" onClick={markAllNotifRead}>
                          すべて既読
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
                              borderBottom: "1px solid #f1f5f9",
                              background: n.readAt ? "#ffffff" : "#f0fdf4",
                            }}
                            onClick={() => {
                              setNotifOpen(false);
                              handleNotifClick(n);
                            }}
                          >
                            <Group gap="xs" align="flex-start" wrap="nowrap">
                              <Text size="lg" style={{ lineHeight: 1 }}>
                                {n.type === "reply" ? "💬" : "❤️"}
                              </Text>
                              <div style={{ minWidth: 0 }}>
                                <Text size="sm" c="dark" style={{ wordBreak: "break-word" }}>
                                  <b>{n.actorName || n.actorEmail.split("@")[0]}</b>
                                  {n.type === "reply" ? " があなたの投稿に返信しました" : " があなたの投稿にいいねしました"}
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
                  </Box>
                </Popover.Dropdown>
              </Popover>
            </Tooltip>
            <Badge color="green" variant="light" hiddenFrom="sm">
              会員
            </Badge>
            <Button variant="default" size="xs" onClick={logout} visibleFrom="sm">
              ログアウト
            </Button>
          </Group>
        </div>
      </AppShell.Header>

      {/* Left sidebar */}
      <AppShell.Navbar p="xs" style={{ background: "#ffffff", borderRight: "1px solid #e5e7eb" }}>
        <ScrollArea>
          <Stack gap={2}>
            <Text size="xs" fw={700} c="dimmed" p="xs">
              メニュー
            </Text>
            {NAV_ITEMS.map((item) =>
              item.href ? (
                <a
                  key={item.key}
                  href={item.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "10px 12px",
                    borderRadius: 8,
                    marginBottom: 2,
                    color: "#343a40",
                    textDecoration: "none",
                    fontSize: 14,
                  }}
                >
                  <span style={{ fontSize: 16 }}>{item.icon}</span>
                  <span style={{ flex: 1 }}>{item.label}</span>
                  <span style={{ fontSize: 11, color: "#adb5bd" }}>↗</span>
                </a>
              ) : (
                <NavLink
                  key={item.key}
                  active={activeNav === item.key}
                  label={item.label}
                  leftSection={<span>{item.icon}</span>}
                  onClick={() => {
                    setActiveNav(item.key);
                    setNavOpened(false);
                  }}
                  style={{
                    borderRadius: 8,
                    marginBottom: 2,
                    ...(activeNav === item.key
                      ? { background: "#dcfce7", color: "#15803d", fontWeight: 600 }
                      : {}),
                  }}
                />
              )
            )}
          </Stack>
        </ScrollArea>
      </AppShell.Navbar>

      {/* Right sidebar: visible only on very wide screens */}
      <AppShell.Aside p="md" style={{ background: "#f8fafc", borderLeft: "1px solid #e5e7eb" }}>
        <Stack gap="sm">
          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Text fw={700} size="sm" mb={4}>
              お知らせ 📢
            </Text>
            <Text size="xs" c="dimmed">
              B-guru（backspace.fm 有料会員サービス）のフィードで、テキスト・画像の投稿とエピソードの自動配信ができます。
            </Text>
          </Paper>
          <Paper p="sm" radius="md" withBorder shadow="xs">
            <Text fw={700} size="sm" mb={4}>
              直近のエピソード
            </Text>
            {episodes.slice(0, 5).map((ep) => (
              <Text key={ep.id} size="xs" c="dimmed" truncate mb={2}>
                {ep.title}
              </Text>
            ))}
          </Paper>
        </Stack>
      </AppShell.Aside>

      {/* Main: feed or episodes */}
      <AppShell.Main
        style={{ background: "#f8fafc", minHeight: "100vh" }}
        onClick={(e) => {
          // In thread view, tapping the wide left/right margin (or any area
          // outside the post cards/controls) returns to the timeline.
          if (!threadPost) return;
          const t = e.target as HTMLElement;
          if (t.closest(".mantine-Card-root, button, a, input, textarea, img")) return;
          closeThread();
        }}
      >
        <div
          className="mx-auto px-3 py-4 sm:px-6 sm:py-6"
          style={{ maxWidth: 640 }}
        >
          {isCenterView && (
            <Stack gap="md">
              {/* Composer (hidden on gallery/news? show only on home feed) */}
              {activeNav === "feed" && !threadPost && (
                <Paper p="md" radius="md" withBorder shadow="sm">
                  <Group align="flex-start" gap="sm" mb="xs">
                    <Avatar src={avatarSrc} alt={displayName} radius="xl" size="md" color="green">
                      {displayName.charAt(0).toUpperCase()}
                    </Avatar>
                    <Text fw={600} size="sm" c="dark">
                      {auth.name || auth.email}
                    </Text>
                  </Group>
                  <form onSubmit={submitPost}>
                    <Textarea
                      placeholder="今なにしてる？ (画像投稿もできます)"
                      autosize
                      minRows={2}
                      value={postText}
                      onChange={(e) => setPostText(e.currentTarget.value)}
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

              {/* Section title */}
              {activeNav !== "feed" && (
                <Title order={3} c="dark">
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
                  {activeNav === "gallery"
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
                          avatarSrc={avatarSrc}
                          isThreadRoot
                          onOpenThread={openThread}
                          onOpenThreadReply={openThreadReply}
                          onLike={handleLike}
                          onReply={openThreadReply}
                          onEdit={openEdit}
                          onDelete={setDeleteTarget}
                          onPin={handlePin}
                          onPreview={setPreviewImage}
                        />
                      )}

                      {/* Replies in chronological order */}
                      {threadReplies.length > 0 && <Divider label="返信" labelPosition="left" />}
                      {threadReplies.map((rep) => (
                        <PostCard
                          key={rep.id}
                          post={rep}
                          auth={auth}
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
                          <Textarea
                            autosize
                            minRows={2}
                            placeholder={`${threadPost.authorName || "この投稿"} に返信…`}
                            value={replyText}
                            onChange={(e) => setReplyText(e.currentTarget.value)}
                            mb="xs"
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                                if ((e.nativeEvent as any).isComposing) return;
                                e.preventDefault();
                                submitThreadReply();
                              }
                            }}
                          />
                            {replyError && (
                              <Text size="sm" c="red" mb="xs">
                                {replyError}
                              </Text>
                            )}
                            <Group justify="flex-end">
                              <Button size="xs" color="green" loading={replying} disabled={!replyText.trim()} type="submit">
                                返信する
                              </Button>
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
                  inlineReplyFor={inlineReplyFor}
                  inlineReplyText={inlineReplyText}
                  onInlineReplyChange={setInlineReplyText}
                  onToggleInlineReply={toggleInlineReply}
                  onInlineReplySubmit={submitInlineReply}
                  onOpenThread={openThread}
                  onOpenThreadReply={openThreadReply}
                  onLike={handleLike}
                  onReply={openThreadReply}
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
              color: "#fff",
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
            <Textarea
              autosize
              minRows={3}
              placeholder="本文"
              value={editText}
              onChange={(e) => setEditText(e.currentTarget.value)}
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
        <Text size="sm" c="dark" mb="md">
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
    </AppShell>
  );
}
