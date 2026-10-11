/**
 * フェーズ2 テスト: /mcp ツール層（トークン検証・スコープ強制・エラー透過）
 * と書き込み系 /api/agent/* ルート。DB/Ghost はモック・ハンドラは実物。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({
  pool: {
    query: (...a: unknown[]) => query(...a),
    connect: async () => ({ query: (...a: unknown[]) => query(...a), release: () => {} }),
  },
}));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    ensureUserId: async () => "uid_me",
    userIdToEmail: async (id: string) => (id === "uid_author" ? "author@example.com" : null),
    emailToUserId: async () => "uid_x",
    emailToUserIds: async () => new Map(),
  };
});

const findMemberByEmail = vi.fn();
vi.mock("@/lib/ghost", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    findMemberByEmail: (...a: unknown[]) => findMemberByEmail(...(a as [string])),
    isPaidMember: (m: unknown) => (m as { status?: string })?.status === "paid",
  };
});

vi.mock("@/lib/club-visibility", () => ({ getHiddenClubs: async () => new Set() }));
vi.mock("@/lib/favorites", () => ({ getFavoriteEmails: async () => new Set() }));
vi.mock("@/lib/bookmarks", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, getBookmarkedPostIds: async () => [] };
});
vi.mock("@/lib/club-store", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    listClubs: async () => [{ key: "photo", name: "写真部", category: "趣味", definition: "撮影", active: true, manual: false, sort: 1 }],
    isActiveClubKey: async (k: string) => k === "photo",
  };
});
vi.mock("@/lib/notifications", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, listNotifications: async () => [] };
});
vi.mock("@/lib/chat", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, listChatMessages: async () => [] };
});
vi.mock("@/lib/display-name", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, resolveDisplayNames: async () => new Map(), resolveDisplayName: async () => null };
});
vi.mock("@/lib/live", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, emitLive: vi.fn() };
});
vi.mock("@/lib/profile", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, getProfile: async () => ({ name: "テスト太郎" }) };
});
const toggleReaction = vi.fn();
vi.mock("@/lib/reactions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, toggleReaction: (...a: unknown[]) => toggleReaction(...(a as [string])) };
});
const markPostsRead = vi.fn();
vi.mock("@/lib/read-state-server", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, markPostsRead: (...a: unknown[]) => markPostsRead(...(a as [string])) };
});
const addBookmark = vi.fn();
const removeBookmark = vi.fn();
const isBookmarked = vi.fn();
vi.mock("@/lib/bookmarks", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    addBookmark: (...a: unknown[]) => addBookmark(...(a as [string])),
    removeBookmark: (...a: unknown[]) => removeBookmark(...(a as [string])),
    isBookmarked: (...a: unknown[]) => isBookmarked(...(a as [string])),
    getBookmarkedPostIds: async () => [],
  };
});

import { POST as mcpPOST } from "@/app/mcp/route";
import { POST as postsPOST, GET as postsGET } from "@/app/api/agent/posts/route";
import { GET as postGET, PATCH as postPATCH, DELETE as postDELETE } from "@/app/api/agent/posts/[id]/route";
import { POST as reactionsPOST } from "@/app/api/agent/reactions/route";
import { POST as readPOST } from "@/app/api/agent/read/route";
import { POST as bookmarksPOST } from "@/app/api/agent/bookmarks/route";

const TOKEN_ROW = (scopes: string[]) => ({
  id: 1,
  token_hash: "h",
  email: "me@example.com",
  scopes,
  device_name: "test",
  expires_at: new Date(Date.now() + 86400_000),
  last_membership_check: new Date(),
});

function seedValidToken(scopes: string[]) {
  query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(scopes)] };
    if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
    if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
}

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

function mcpReq(body: unknown, auth = "Bearer bga_test"): Request {
  return new Request("http://x/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: auth,
    },
    body: JSON.stringify(body),
  });
}

async function callMcp(body: unknown, auth = "Bearer bga_test") {
  const res = await mcpPOST(mcpReq(body, auth));
  const text = await res.text();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text, status: res.status };
  }
  return { status: res.status, json };
}

/** tools/call の結果 text をパースする。 */
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function toolResult(json: any): any {
  expect(json.result?.content?.[0]?.text).toBeDefined();
  return JSON.parse(json.result.content[0].text);
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  findMemberByEmail.mockReset();
  toggleReaction.mockReset();
  markPostsRead.mockReset();
  addBookmark.mockReset();
  removeBookmark.mockReset();
  isBookmarked.mockReset();
});

describe("/mcp 認証", () => {
  it("Bearer 無しは 401 {error, code}", async () => {
    const { status, json } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ""
    );
    expect(status).toBe(401);
    expect(json.code).toBe("unauthorized");
  });

  it("未知トークンは 401", async () => {
    const { status, json } = await callMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(status).toBe(401);
    expect(json.code).toBe("unauthorized");
  });

  it("membership_ended には BSM 会員案内 hint が含まれる", async () => {
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) {
        return {
          rows: [{ ...TOKEN_ROW(["read"]), last_membership_check: new Date(Date.now() - 7 * 3600_000) }],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    findMemberByEmail.mockResolvedValue(null); // 非会員
    const { status, json } = await callMcp(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }
    );
    expect(status).toBe(403);
    expect(json.code).toBe("membership_ended");
    expect(json.hint).toContain("backspace.fm");
  });
});

describe("/mcp ツール", () => {
  it("initialize + tools/list が通る", async () => {
    seedValidToken(["read"]);
    const init = await callMcp({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect(init.status).toBe(200);
    const list = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining([
        "get_me", "get_posts", "get_thread", "search_posts", "get_clubs",
        "get_notifications", "get_chat", "post_message", "add_reaction",
        "mark_read", "toggle_bookmark",
      ])
    );
  });

  it("get_me は user_id を返し email を含まない", async () => {
    seedValidToken(["read"]);
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_me", arguments: {} } });
    const d = toolResult(r.json);
    expect(d.user_id).toBe("uid_me");
    expect(JSON.stringify(d)).not.toContain("example.com");
  });

  it("get_posts が read スコープで動く", async () => {
    seedValidToken(["read"]);
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["read"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      if (s.includes("FROM posts p") || s.includes("FROM posts\n")) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_posts", arguments: { limit: 10 } } });
    const d = toolResult(r.json);
    expect(d.apiVersion).toBe(1);
    expect(Array.isArray(d.posts)).toBe(true);
  });
});

describe("/mcp スコープ強制", () => {
  it("read のみのトークンで post_message は forbidden", async () => {
    seedValidToken(["read"]);
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "post_message", arguments: { text: "hello" } },
    });
    expect(r.json.result.isError).toBe(true);
    const d = toolResult(r.json);
    expect(d.code).toBe("forbidden");
  });

  it("read のみのトークンで mark_read は forbidden", async () => {
    seedValidToken(["read"]);
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "mark_read", arguments: { post_id: 1 } },
    });
    const d = toolResult(r.json);
    expect(d.code).toBe("forbidden");
  });

  it("edit_post / delete_post が tools/list に含まれる", async () => {
    seedValidToken(["write"]);
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const list = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("edit_post");
    expect(list.json.result.tools.map((t: { name: string }) => t.name)).toContain("delete_post");
  });

  it("edit_post — write スコープで UPDATE posts SET text が走る", async () => {
    seedValidToken(["write"]);
    const captured: { sql: string; params: unknown[] }[] = [];
    query.mockImplementation(async (sql: unknown, params: unknown[]) => {
      const s = String(sql);
      captured.push({ sql: s, params: params ?? [] });
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      // getPostAuthor / source_ghost_id
      if (s.includes("SELECT author_email FROM posts WHERE id = $1")) return { rows: [{ author_email: "me@example.com" }] };
      if (s.includes("SELECT source_ghost_id")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "edit_post", arguments: { post_id: 5, text: "edited text" } },
    });
    expect(r.json.result.isError).toBeUndefined();
    const d = toolResult(r.json);
    expect(d.updated).toBe(true);
    const upd = captured.find((c) => c.sql.includes("UPDATE posts SET text"));
    expect(upd).toBeDefined();
    expect(upd!.params).toContain("edited text");
  });

  it("delete_post — write スコープで DELETE FROM posts が走る", async () => {
    seedValidToken(["write"]);
    const captured: string[] = [];
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      captured.push(s);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      if (s.includes("SELECT author_email FROM posts WHERE id = $1")) return { rows: [{ author_email: "me@example.com" }] };
      if (s.includes("SELECT source_ghost_id")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const r = await callMcp({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "delete_post", arguments: { post_id: 5 } },
    });
    const d = toolResult(r.json);
    expect(d.deleted).toBe(true);
    expect(captured.some((s) => s.includes("DELETE FROM posts WHERE id"))).toBe(true);
  });

  it("read のみのトークンで edit_post / delete_post は forbidden", async () => {
    seedValidToken(["read"]);
    await callMcp({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const e1 = await callMcp({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "edit_post", arguments: { post_id: 5, text: "x" } },
    });
    expect(toolResult(e1.json).code).toBe("forbidden");
    const e2 = await callMcp({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "delete_post", arguments: { post_id: 5 } },
    });
    expect(toolResult(e2.json).code).toBe("forbidden");
  });
});

describe("書き込み系 /api/agent/* ルート", () => {
  it("POST /api/agent/posts — write スコープで 201・via 列を含む INSERT", async () => {
    seedValidToken(["write"]);
    const captured: string[] = [];
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      captured.push(s);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      if (s.includes("INSERT INTO posts")) return { rows: [{ id: 9, created_at: new Date() }], rowCount: 1 };
      if (s.includes("UPDATE posts SET club")) return { rowCount: 1 };
      // follow-up SELECTs (poll rebuild etc.) → empty
      return { rows: [], rowCount: 0 };
    });
    const res = await postsPOST(
      req("http://x/api/agent/posts", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ text: "agent 投稿", club: "photo" }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.post.text).toBeDefined();
    const insert = captured.find((s) => s.includes("INSERT INTO posts"));
    expect(insert).toContain("via");
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("POST /api/agent/posts — read スコープでは 403", async () => {
    seedValidToken(["read"]);
    const res = await postsPOST(
      req("http://x/api/agent/posts", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ text: "x" }),
      })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("POST /api/agent/reactions — write スコープでトグル", async () => {
    seedValidToken(["write"]);
    toggleReaction.mockResolvedValue({ added: true, reactions: [{ emoji: "👍", count: 2, mine: true, reactors: [] }] });
    const res = await reactionsPOST(
      req("http://x/api/agent/reactions", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: 3, emoji: "👍" }),
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.added).toBe(true);
    expect(toggleReaction).toHaveBeenCalledWith("post", 3, "me@example.com", "👍");
  });

  it("POST /api/agent/read — read_state スコープ必須・write では 403", async () => {
    seedValidToken(["write"]);
    const res = await readPOST(
      req("http://x/api/agent/read", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: 3 }),
      })
    );
    expect(res.status).toBe(403);
  });

  it("POST /api/agent/read — read_state スコープで 200", async () => {
    seedValidToken(["read_state"]);
    markPostsRead.mockResolvedValue(1);
    const res = await readPOST(
      req("http://x/api/agent/read", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: 3 }),
      })
    );
    expect(res.status).toBe(200);
    expect((await res.json()).marked).toBe(1);
  });

  it("POST /api/agent/bookmarks — write スコープで追加・未存在は 404", async () => {
    seedValidToken(["write"]);
    isBookmarked.mockResolvedValue(false);
    addBookmark.mockResolvedValue(true);
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      if (s.includes("FROM posts WHERE id")) return { rows: [{ "?column?": 1 }] };
      return { rows: [], rowCount: 0 };
    });
    const ok = await bookmarksPOST(
      req("http://x/api/agent/bookmarks", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: 5 }),
      })
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()).bookmarked).toBe(true);

    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      return { rows: [], rowCount: 0 }; // 投稿なし
    });
    const nf = await bookmarksPOST(
      req("http://x/api/agent/bookmarks", {
        method: "POST",
        headers: { Authorization: "Bearer bga_test", "Content-Type": "application/json" },
        body: JSON.stringify({ post_id: 999 }),
      })
    );
    expect(nf.status).toBe(404);
  });

  it("書き込み系全ルート — Bearer 無しは 401", async () => {
    for (const [url, h] of [
      ["http://x/api/agent/posts", postsPOST],
      ["http://x/api/agent/reactions", reactionsPOST],
      ["http://x/api/agent/read", readPOST],
      ["http://x/api/agent/bookmarks", bookmarksPOST],
    ] as const) {
      const res = await h(req(url, { method: "POST", body: JSON.stringify({}) }));
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("unauthorized");
    }
  });
});

describe("PATCH / DELETE /api/agent/posts/[id]", () => {
  function routeParams() {
    return { params: Promise.resolve({ id: "7" }) };
  }

  function postRouteReq(method: string, body?: unknown, auth = "Bearer bga_test") {
    return req(`http://x/api/agent/posts/7`, {
      method,
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  function authorQuery(authorEmail: string | null) {
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [TOKEN_ROW(["write"])] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("UPDATE agent_tokens SET last_used_at")) return { rowCount: 1 };
      if (s.includes("SELECT author_email FROM posts WHERE id = $1"))
        return authorEmail ? { rows: [{ author_email: authorEmail }] } : { rows: [] };
      if (s.includes("SELECT source_ghost_id")) return { rows: [] };
      return { rows: [], rowCount: 0 };
    });
  }

  it("PATCH — 自分の投稿は text のみ UPDATE・メディア系 UPDATE は走らない", async () => {
    seedValidToken(["write"]);
    authorQuery("me@example.com");
    const captured: string[] = [];
    const prev = query.getMockImplementation()!;
    query.mockImplementation(async (sql: unknown, ...rest: unknown[]) => {
      captured.push(String(sql));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prev as any)(sql, ...rest);
    });
    const res = await postPATCH(postRouteReq("PATCH", { text: "new text" }), routeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(true);
    expect(captured.some((s) => s.includes("UPDATE posts SET text"))).toBe(true);
    expect(captured.some((s) => s.includes("post_images"))).toBe(false);
    expect(captured.some((s) => s.includes("video_url") && s.includes("UPDATE"))).toBe(false);
    expect(captured.some((s) => s.includes("audio_url") && s.includes("UPDATE"))).toBe(false);
  });

  it("PATCH — 他人の投稿は 403 forbidden", async () => {
    seedValidToken(["write"]);
    authorQuery("author@example.com");
    const res = await postPATCH(postRouteReq("PATCH", { text: "x" }), routeParams());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("PATCH — 存在しない投稿は 404 not_found", async () => {
    seedValidToken(["write"]);
    authorQuery(null);
    const res = await postPATCH(postRouteReq("PATCH", { text: "x" }), routeParams());
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("PATCH — read スコープでは 403", async () => {
    seedValidToken(["read"]);
    const res = await postPATCH(postRouteReq("PATCH", { text: "x" }), routeParams());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("DELETE — 自分の投稿は 200・DELETE FROM posts が走る", async () => {
    seedValidToken(["write"]);
    authorQuery("me@example.com");
    const captured: string[] = [];
    const prev = query.getMockImplementation()!;
    query.mockImplementation(async (sql: unknown, ...rest: unknown[]) => {
      captured.push(String(sql));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (prev as any)(sql, ...rest);
    });
    const res = await postDELETE(postRouteReq("DELETE"), routeParams());
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(captured.some((s) => s.includes("DELETE FROM posts WHERE id"))).toBe(true);
  });

  it("DELETE — 他人の投稿は 403", async () => {
    seedValidToken(["write"]);
    authorQuery("author@example.com");
    const res = await postDELETE(postRouteReq("DELETE"), routeParams());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("forbidden");
  });

  it("DELETE — 存在しない投稿は 404", async () => {
    seedValidToken(["write"]);
    authorQuery(null);
    const res = await postDELETE(postRouteReq("DELETE"), routeParams());
    expect(res.status).toBe(404);
  });

  it("PATCH / DELETE — Bearer 無しは 401", async () => {
    const p = await postPATCH(postRouteReq("PATCH", { text: "x" }, ""), routeParams());
    expect(p.status).toBe(401);
    expect((await p.json()).code).toBe("unauthorized");
    const d = await postDELETE(postRouteReq("DELETE", undefined, ""), routeParams());
    expect(d.status).toBe(401);
  });

  it("GET /api/agent/posts/[id] — 既存 GET は従来どおり 404（投稿なし）", async () => {
    seedValidToken(["read"]);
    const res = await postGET(req("http://x/api/agent/posts/7", { headers: { Authorization: "Bearer bga_test" } }), routeParams());
    expect(res.status).toBe(404);
  });
});

describe("既存 GET ルートのデグレ確認", () => {
  it("GET /api/agent/posts は従来どおり動く", async () => {
    seedValidToken(["read"]);
    const res = await postsGET(req("http://x/api/agent/posts", { headers: { Authorization: "Bearer bga_test" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiVersion).toBe(1);
  });
});
