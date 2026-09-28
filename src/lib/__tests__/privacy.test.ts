/**
 * Privacy regression guard: no member email may reach a client.
 *
 * The timeline / chat / drinews / notification payloads are served to EVERY
 * logged-in member, so a single `authorEmail` field anywhere in them leaks the
 * whole membership list to anyone who opens devtools.
 *
 * ── WHY THIS FILE CALLS THE REAL MAPPERS ────────────────────────────────────
 * An earlier version of this test hand-built `FeedPost` literals and asserted
 * on them. It passed 366/366 while `mapRow` still attached `authorEmail` to
 * every row, because it never called `mapRow` — it asserted on a fixture the
 * test itself authored. A guard that cannot fail when the code regresses is
 * decorative.
 *
 * So: mock ONLY the database (`../db`), then call the real `listPosts` /
 * `getPostThread` / `listChatMessages` / `listDrinews` / `listNotifications`
 * and assert on what they actually return. If someone reintroduces an email
 * field in a mapper, these tests fail.
 *
 * If one of these fails, do NOT relax the assertion: find the field that
 * reintroduced the email and replace it with the opaque `authorId`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "node:fs/promises";

// ── Database mock ───────────────────────────────────────────────────────────
// Every query returns the rows the test queued for it, in order. The mappers
// themselves are the real ones — that is the whole point.
const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

// Display-name resolution hits the DB too; keep it real but let it fall through
// to the row's own author_name so the assertions stay about emails.
vi.mock("../display-name", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    resolveDisplayNames: async (emails: string[]) =>
      new Map(emails.map((e) => [e, null])),
    resolveDisplayName: async () => null,
  };
});

// The user-id resolver is the ONE thing we stub, because it is the boundary
// under test: it must be the only path from an email to a public identifier.
// A real implementation would query `users`; here we derive a deterministic
// opaque id so we can assert the DTO carries it and not the address.
vi.mock("../user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  const toId = (email: string | null | undefined) =>
    email ? `uid_${email.split("@")[0]}` : null;
  return {
    ...actual,
    emailToUserId: async (email: string) => toId(email),
    emailToUserIds: async (emails: (string | null | undefined)[]) => {
      const m = new Map<string, string>();
      for (const e of emails) {
        if (e) m.set(e.trim().toLowerCase(), `uid_${e.split("@")[0]}`);
      }
      return m;
    },
  };
});

import { listPosts, getPostThread } from "../posts";
import { listChatMessages } from "../chat";
import { listPublishedDrinews, listComments } from "../drinews";
import { listNotifications } from "../notifications";
import { groupFeed, groupKey } from "../feed";
import type { FeedPost } from "../feed";
import type { LiveEvent } from "../live";

const AUTHOR_EMAIL = "drikin@gmail.com";
const OTHER_EMAIL = "matsuo@gmail.com";

/** A raw `posts` row exactly as POST_SELECT returns it (email is internal). */
function postRow(over: Record<string, unknown> = {}) {
  return {
    id: 42,
    author_email: AUTHOR_EMAIL,
    author_id: "uid_drikin",
    is_author: false,
    author_name: "ドリキン",
    parent_id: null,
    reply_count: 0,
    text: "テスト投稿",
    images: [],
    video_url: null,
    audio_url: null,
    url_preview: null,
    like_count: 0,
    liked_by_me: false,
    created_at: "2026-09-28T09:00:00.000Z",
    last_activity: "2026-09-28T09:00:00.000Z",
    pinned_at: null,
    poll_json: null,
    club: null,
    club_manual: false,
    ...over,
  };
}

/** Recursively collect every key name in a JSON-ish value. */
function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) allKeys(v, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

/** Assert a serialized payload carries no address and no email-ish key. */
function expectEmailFree(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain("@");
  const keys = allKeys(payload);
  for (const k of ["authorEmail", "email", "userEmail", "actorEmail", "emails"]) {
    expect(keys.has(k), `payload leaked key "${k}"`).toBe(false);
  }
}

beforeEach(() => {
  query.mockReset();
});

// ── The real serialization boundary ─────────────────────────────────────────

describe("listPosts (GET /api/posts) — real mapper", () => {
  it("returns posts with no email anywhere in the payload", async () => {
    // listPosts issues: the main page query, then the reply query.
    query.mockResolvedValueOnce({ rows: [postRow()] });
    query.mockResolvedValueOnce({ rows: [] });

    const posts = await listPosts({ viewerEmail: OTHER_EMAIL });
    expect(posts).toHaveLength(1);
    expectEmailFree(posts);
  });

  it("carries the opaque authorId and a server-computed isAuthor", async () => {
    query.mockResolvedValueOnce({ rows: [postRow({ is_author: true })] });
    query.mockResolvedValueOnce({ rows: [] });

    const posts = await listPosts({ viewerEmail: AUTHOR_EMAIL });
    expect(posts[0].authorId).toBe("uid_drikin");
    expect(posts[0].isAuthor).toBe(true);
  });

  it("stays email-free when the author has no users row (authorId '')", async () => {
    query.mockResolvedValueOnce({
      rows: [postRow({ author_id: "", author_email: OTHER_EMAIL })],
    });
    query.mockResolvedValueOnce({ rows: [] });

    const posts = await listPosts({ viewerEmail: AUTHOR_EMAIL });
    expect(posts[0].authorId).toBe("");
    expectEmailFree(posts);
  });
});

describe("getPostThread — real mapper", () => {
  it("returns the post and its replies with no email", async () => {
    query.mockResolvedValueOnce({ rows: [postRow()] });
    query.mockResolvedValueOnce({
      rows: [postRow({ id: 43, parent_id: 42, author_email: OTHER_EMAIL })],
    });

    const thread = await getPostThread(42, AUTHOR_EMAIL);
    expect(thread).not.toBeNull();
    expectEmailFree(thread);
  });
});

describe("listChatMessages (GET /api/chat) — real mapper", () => {
  it("returns chat messages with no email", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 7,
          author_email: AUTHOR_EMAIL,
          author_name: "ドリキン",
          body: "やあ",
          edited: false,
          edited_at: null,
          created_at: "2026-09-28T09:00:00.000Z",
        },
      ],
    });

    const msgs = await listChatMessages({ viewerEmail: OTHER_EMAIL });
    expect(msgs).toHaveLength(1);
    expectEmailFree(msgs);
    expect(msgs[0].authorId).toBe("uid_drikin");
  });
});

describe("listPublishedDrinews (GET /api/drinews) — real mapper", () => {
  it("returns articles with no email", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 30,
          author_email: AUTHOR_EMAIL,
          author_name: "ドリキン",
          title: "タイトル",
          body_md: "本文",
          body_html: "<p>本文</p>",
          header_image: null,
          status: "published",
          scheduled_at: null,
          published_at: "2026-09-28T09:00:00.000Z",
          created_at: "2026-09-28T09:00:00.000Z",
          updated_at: "2026-09-28T09:00:00.000Z",
          comment_count: 0,
        },
      ],
    });

    const articles = await listPublishedDrinews(OTHER_EMAIL);
    expect(articles).toHaveLength(1);
    expectEmailFree(articles);
  });
});

describe("listComments (GET /api/drinews/[id]) — real mapper", () => {
  it("returns comments with no email", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 5,
          article_id: 30,
          author_email: OTHER_EMAIL,
          author_name: "松尾",
          comment: "いいね",
          created_at: "2026-09-28T09:00:00.000Z",
        },
      ],
    });

    const comments = await listComments(30, AUTHOR_EMAIL);
    expect(comments).toHaveLength(1);
    expectEmailFree(comments);
  });
});

describe("listNotifications (GET /api/notifications) — real mapper", () => {
  it("returns notifications with no email", async () => {
    query.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          type: "reply",
          actor_email: OTHER_EMAIL,
          actor_name: "松尾",
          post_id: 42,
          reply_id: 43,
          text: "返信しました",
          read_at: null,
          created_at: "2026-09-28T09:00:00.000Z",
        },
      ],
    });

    const notes = await listNotifications(AUTHOR_EMAIL);
    expect(notes).toHaveLength(1);
    expectEmailFree(notes);
  });
});

// ── Derived shapes ──────────────────────────────────────────────────────────

describe("FeedGroup payload carries no email", () => {
  it("groups real mapper output without leaking an address", async () => {
    query.mockResolvedValueOnce({ rows: [postRow()] });
    query.mockResolvedValueOnce({ rows: [] });
    const posts = await listPosts({ viewerEmail: OTHER_EMAIL });

    const groups = groupFeed(posts);
    expect(groups).toHaveLength(1);
    expectEmailFree(groups);
  });

  it("falls back to an empty author name rather than the email local part", () => {
    // The old fallback was `authorEmail.split("@")[0]`, which re-leaked the
    // address in the UI even after the field was removed.
    const p = {
      id: 1,
      authorName: null,
      authorId: "uid_x",
      lastActivityAt: "2026-09-28T01:00:00.000Z",
    } as unknown as FeedPost;
    const groups = groupFeed([p]);
    expect(groups[0].authorName).toBe("");
    expect(groups[0].authorName).not.toContain("@");
  });
});

describe("LiveEvent (SSE) payloads carry no email", () => {
  it("post create/update/delete events carry only the opaque authorId", () => {
    const events: LiveEvent[] = [
      { type: "post", postId: 1, action: "create", authorId: "AbCdefGHijKl" },
      { type: "post", postId: 1, action: "update", authorId: "AbCdefGHijKl" },
      { type: "post", postId: 1, action: "delete", authorId: "AbCdefGHijKl" },
    ];
    for (const e of events) expectEmailFree(e);
  });

  it("presence events carry userIds, not emails", () => {
    const e: LiveEvent = {
      type: "presence",
      userIds: ["AbCdefGHijKl", "ZzYyXxWwVvUu"],
    };
    expectEmailFree(e);
    expect(allKeys(e).has("userIds")).toBe(true);
  });

  it("chat events carry authorId only — isAuthor is per-receiver and must not be broadcast", () => {
    // One SSE payload is fanned out to every connected client, so a per-viewer
    // flag cannot live in it. Clients derive it from their own user id.
    const e = {
      type: "chat",
      action: "create",
      message: {
        id: 7,
        authorId: "AbCdefGHijKl",
        authorName: "ドリキン",
        body: "やあ",
      },
    } as unknown as LiveEvent;
    expectEmailFree(e);
    expect(allKeys(e).has("isAuthor")).toBe(false);
  });

  it("the chat route strips isAuthor before broadcasting", async () => {
    // Regression guard for a real bug: the route passed the whole ChatMessage
    // (built with viewerEmail = the sender, so isAuthor: true) straight to
    // emitLive. Every other member then rendered the sender's message as their
    // own — right-aligned, with edit/delete buttons that 403'd on click.
    // Assert on the source, because the strip happens at the call site.
    const src = await readFile(
      new URL("../../app/api/chat/route.ts", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/const\s*\{\s*isAuthor:[^}]*\}\s*=\s*message/);
    expect(src).not.toMatch(/emitLive\(\{\s*type:\s*"chat",\s*message,\s*action/);

    const editSrc = await readFile(
      new URL("../../app/api/chat/[id]/route.ts", import.meta.url),
      "utf8"
    );
    expect(editSrc).toMatch(/const\s*\{\s*isAuthor:[^}]*\}\s*=\s*updated/);
    expect(editSrc).not.toMatch(/emitLive\(\{\s*type:\s*"chat",\s*action:\s*"edit",\s*message:\s*updated/);
  });
});

describe("group key uniqueness (React key collisions)", () => {
  it("does not collide for the same author posting twice on the same day", () => {
    const groups = groupFeed([
      { id: 1, authorId: "sameAuthor12", lastActivityAt: "2026-09-28T01:00:00.000Z" } as unknown as FeedPost,
      { id: 2, authorId: "sameAuthor12", lastActivityAt: "2026-09-28T02:00:00.000Z" } as unknown as FeedPost,
    ]);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map(groupKey)).size).toBe(2);
  });

  it("does not collide for two authors posting on the same day", () => {
    const groups = groupFeed([
      { id: 1, authorId: "authorAaaaaa1", lastActivityAt: "2026-09-28T01:00:00.000Z" } as unknown as FeedPost,
      { id: 2, authorId: "authorBbbbbb2", lastActivityAt: "2026-09-28T02:00:00.000Z" } as unknown as FeedPost,
    ]);
    expect(new Set(groups.map(groupKey)).size).toBe(2);
  });

  it("never embeds an email in the key", () => {
    const groups = groupFeed([
      { id: 1, authorId: "uid_drikin", lastActivityAt: "2026-09-28T01:00:00.000Z" } as unknown as FeedPost,
    ]);
    expect(groupKey(groups[0])).not.toContain("@");
  });
});
