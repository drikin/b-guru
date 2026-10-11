/**
 * /api/agent/* ルートの統合テスト（DB/Ghost/session はモック・ハンドラは実物）。
 * 重点:
 *  - 認証ゲート（Bearer 無し/無効 → 401 統一エラー形状）
 *  - privacy: 全レスポンスに email / member 情報を含まない
 *  - 既存 /api/* と同じ形状の破壊をしない
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const sessionEmail = vi.fn();
vi.mock("@/lib/session", () => ({ getSessionEmail: () => sessionEmail() }));

const findMemberByEmail = vi.fn();
vi.mock("@/lib/ghost", () => ({
  findMemberByEmail: (...a: unknown[]) => findMemberByEmail(...(a as [string])),
  isPaidMember: (m: any) => m.status === "paid",
}));

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

vi.mock("@/lib/display-name", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, resolveDisplayNames: async () => new Map(), resolveDisplayName: async () => null };
});

vi.mock("@/lib/club-visibility", () => ({ getHiddenClubs: async () => new Set() }));
vi.mock("@/lib/favorites", () => ({ getFavoriteEmails: async () => new Set() }));
vi.mock("@/lib/bookmarks", () => ({ getBookmarkedPostIds: async () => [] }));
vi.mock("@/lib/club-store", () => ({
  listClubs: async () => [{ key: "photo", name: "写真部", category: "趣味", definition: "撮影の話", active: true, manual: false, sort: 1 }],
}));

// 通知（email を含まない DTO を既存 lib が返す経路を実物で通す）
vi.mock("@/lib/notifications", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, listNotifications: async () => [{ id: 1, type: "reply", actorId: "uid_actor", actorName: "actor", isActor: false, postId: 2, replyId: 3, text: "t", readAt: null, createdAt: "2026-01-01T00:00:00Z" }] };
});

vi.mock("@/lib/chat", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, listChatMessages: async () => [{ id: 1, authorId: "uid_actor", isAuthor: false, authorName: "actor", body: "hello", createdAt: "2026-01-01T00:00:00Z", avatar: "", edited: false, editedAt: null }] };
});

import { GET as meGET } from "@/app/api/agent/me/route";
import { GET as postsGET } from "@/app/api/agent/posts/route";
import { GET as searchGET } from "@/app/api/agent/search/route";
import { GET as clubsGET } from "@/app/api/agent/clubs/route";
import { GET as notificationsGET } from "@/app/api/agent/notifications/route";
import { GET as chatGET } from "@/app/api/agent/chat/route";
import { POST as tokenPOST } from "@/app/api/agent/token/route";

const VALID_ROW = () => ({
  id: 1,
  email: "me@example.com",
  scopes: ["read"],
  device_name: "test",
  expires_at: new Date(Date.now() + 86400_000),
  last_membership_check: new Date(), // 再判定不要
});

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(url, init));
}

async function authedTokenQuery() {
  query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash")) return { rows: [VALID_ROW()] };
    if (s.includes("INSERT INTO rate_limits"))
      return { rows: [{ count: 1, window_start: new Date() }] };
    return { rows: [], rowCount: 0 };
  });
}

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v as object)) { out.add(k); allKeys(x, out); }
  return out;
}

beforeEach(() => {
  query.mockReset();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  sessionEmail.mockReset();
  findMemberByEmail.mockReset();
});

describe("認証ゲート", () => {
  it("Bearer 無しは 401 {error, code:'unauthorized'}（全ルート共通）", async () => {
    for (const h of [meGET, postsGET, searchGET, clubsGET, notificationsGET, chatGET]) {
      const res = await h(req("http://x/api/agent/x"));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.code).toBe("unauthorized");
      expect(typeof body.error).toBe("string");
    }
  });

  it("未知トークンは 401", async () => {
    const res = await meGET(req("http://x/api/agent/me", { headers: { Authorization: "Bearer bga_nope" } }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("unauthorized");
  });
});

describe("GET /api/agent/me", () => {
  it("email を含まず user_id / scopes / expires_at を返す", async () => {
    await authedTokenQuery();
    const res = await meGET(req("http://x/api/agent/me", { headers: { Authorization: "Bearer bga_x" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user_id).toBe("uid_me");
    expect(body.apiVersion).toBe(1);
    const bodyText = JSON.stringify(body);
    expect(bodyText).not.toContain("me@example.com");
    expect(Object.keys(body)).not.toContain("email");
  });
});

describe("GET /api/agent/posts", () => {
  it("投稿一覧を email 無し DTO で返す（author_id は不透明）", async () => {
    await authedTokenQuery();
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [VALID_ROW()] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("FROM posts")) {
        return {
          rows: [
            {
              id: 10,
              author_id: "uid_author",
              is_author: false,
              author_name: "author",
              author_email: "author@example.com",
              parent_id: null,
              text: "hello",
              url_preview: null,
              created_at: new Date("2026-01-01T00:00:00Z"),
              last_activity: new Date("2026-01-01T00:00:00Z"),
              pinned_at: null,
              images: [],
              video_url: null,
              audio_url: null,
              club: null,
              club_manual: false,
              like_count: 0,
              liked_by_me: false,
              favorited_by_me: false,
              bookmarked_by_me: false,
              reply_count: 0,
              poll_json: null,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });
    const res = await postsGET(req("http://x/api/agent/posts?limit=10", { headers: { Authorization: "Bearer bga_x" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.apiVersion).toBe(1);
    expect(body.posts[0].author_id).toBe("uid_author");
    expect(allKeys(body)).not.toContain("email");
    expect(allKeys(body)).not.toContain("author_email");
    expect(JSON.stringify(body)).not.toContain("@example.com");
    expect(body.next_cursor).toBeNull(); // limit 未満なので終端
  });

  it("limit は 100 にクランプされる", async () => {
    await authedTokenQuery();
    let capturedLimit: unknown;
    query.mockImplementation(async (sql: unknown, params: unknown[]) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash")) return { rows: [VALID_ROW()] };
      if (s.includes("INSERT INTO rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      if (s.includes("FROM posts")) {
        capturedLimit = (params as unknown[])[1];
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });
    await postsGET(req("http://x/api/agent/posts?limit=5000", { headers: { Authorization: "Bearer bga_x" } }));
    expect(Number(capturedLimit)).toBe(100);
  });
});

describe("GET /api/agent/search", () => {
  it("q 無しは 400", async () => {
    await authedTokenQuery();
    const res = await searchGET(req("http://x/api/agent/search", { headers: { Authorization: "Bearer bga_x" } }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/agent/clubs", () => {
  it("カタログを email 無しで返す", async () => {
    await authedTokenQuery();
    const res = await clubsGET(req("http://x/api/agent/clubs", { headers: { Authorization: "Bearer bga_x" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clubs[0].key).toBe("photo");
    expect(allKeys(body)).not.toContain("email");
  });
});

describe("GET /api/agent/notifications & chat", () => {
  it("email を含まない", async () => {
    await authedTokenQuery();
    const nres = await notificationsGET(req("http://x/api/agent/notifications", { headers: { Authorization: "Bearer bga_x" } }));
    const nbody = await nres.json();
    expect(JSON.stringify(nbody)).not.toContain("example.com");
    const cres = await chatGET(req("http://x/api/agent/chat", { headers: { Authorization: "Bearer bga_x" } }));
    const cbody = await cres.json();
    expect(JSON.stringify(cbody)).not.toContain("example.com");
  });
});

describe("POST /api/agent/token", () => {
  it("未ログインは 401", async () => {
    sessionEmail.mockResolvedValue(null);
    const res = await tokenPOST(
      req("http://x/api/agent/token", { method: "POST", body: JSON.stringify({ device_name: "d" }) })
    );
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("unauthorized");
  });

  it("会員ならトークン発行（平文は 1 回だけ返す・expiresAt/userId/scopes 付き）", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    findMemberByEmail.mockResolvedValue({ email: "me@example.com", status: "paid" });
    query.mockResolvedValue({ rows: [{ id: 7, expires_at: new Date(Date.now() + 86400_000) }] });
    const res = await tokenPOST(
      req("http://x/api/agent/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: "Hermes", scopes: ["read"] }),
      })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.token).toMatch(/^bga_[0-9a-f]{64}$/);
    expect(body.userId).toBe("uid_me");
    expect(body.scopes).toEqual(["read"]);
    // DB にはハッシュが渡る
    const [sql, params] = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO agent_tokens"))!;
    expect(params[0]).not.toBe(body.token);
    expect(String(sql)).toContain("token_hash");
  });

  it("非会員は 403 membership_ended", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    findMemberByEmail.mockResolvedValue(null);
    const res = await tokenPOST(
      req("http://x/api/agent/token", { method: "POST", body: JSON.stringify({ device_name: "d" }) })
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("membership_ended");
  });
});
