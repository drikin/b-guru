/**
 * 回数の上限の枠（オーナー決定 2026-10-22・docs/timeline-spec.md §11）。
 *  - 投稿・編集・削除・アップロード: post の枠（1 時間 60）
 *  - 軽い操作（リアクション・投票・ブックマーク・お気に入り・ピン・部活の付け替え）: post_light の枠（1 時間 300）
 *  - 外部エージェントの write の枠（1 時間 10）は変えない（write で通ったら軽い操作でも write の枠）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/ghost", () => ({ findMemberByEmail: async () => null, isPaidMember: () => true, listMembers: async () => [] }));
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me" };
});
vi.mock("@/lib/agent-write", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    agentToggleReaction: async () => ({ added: true, reactions: [] }),
    agentToggleBookmark: async () => ({ bookmarked: true }),
    agentDeletePost: async () => ({ deleted: true }),
  };
});
vi.mock("@/lib/post-actions", () => ({
  togglePinAction: async () => ({ status: 200, body: { ok: true, pinned: true } }),
  setClubAction: async () => ({ status: 200, body: { ok: true, club: null } }),
  votePoll: async () => ({ status: 200, body: { ok: true, poll: null } }),
  setFavorite: async () => ({ status: 200, body: { favorited: true } }),
  deleteOwnPost: async () => ({ status: 200, body: { ok: true } }),
  editOwnPost: async () => ({ status: 200, body: { ok: true } }),
}));
vi.mock("@/lib/publish", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, publishPost: async () => ({ status: 400, body: { error: "x" } }) };
});

import { checkRateLimit, BUCKET_RATE_RULES, RATE_RULES } from "@/lib/agent-auth";
import { POST as reactions } from "@/app/api/agent/reactions/route";
import { POST as bookmarks } from "@/app/api/agent/bookmarks/route";
import { POST as favAdd } from "@/app/api/agent/favorites/route";
import { POST as pin } from "@/app/api/agent/posts/[id]/pin/route";
import { PATCH as club } from "@/app/api/agent/posts/[id]/club/route";
import { POST as vote } from "@/app/api/agent/posts/[id]/poll/vote/route";
import { POST as publish } from "@/app/api/agent/publish/route";
import { DELETE as del } from "@/app/api/agent/posts/[id]/route";

let scopes: string[] = [];
let appIssued = false;
let tokenId = 500;
let rateKeys: string[] = [];
beforeEach(() => {
  tokenId += 1;
  rateKeys = [];
  query.mockReset();
  query.mockImplementation(async (sql: unknown, params?: unknown[]) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash"))
      return { rows: [{ id: tokenId, email: "me@example.com", scopes, device_name: "d", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date(), app_issued: appIssued }] };
    if (s.includes("rate_limits")) {
      rateKeys.push(String(params?.[0]));
      return { rows: [{ count: 1, window_start: new Date() }] };
    }
    return { rows: [], rowCount: 0 };
  });
});
const H = { Authorization: "Bearer bga_x", "Content-Type": "application/json" };
const r = (method: string, body: unknown = {}) => new NextRequest(new Request("http://x/api/agent/x", { method, headers: H, body: JSON.stringify(body) }));
const P = { params: Promise.resolve({ id: "7" }) };
const bucketOf = () => rateKeys[0]?.split(":")[1];

describe("回数の枠", () => {
  it("上限: post 60/時・post_light 300/時・write 10/時（write は変えない）", () => {
    expect(RATE_RULES.post).toEqual({ limit: 60, window: "1 hour" });
    expect(BUCKET_RATE_RULES.post_light).toEqual({ limit: 300, window: "1 hour" });
    expect(RATE_RULES.write).toEqual({ limit: 10, window: "1 hour" });
  });

  it("アプリの鍵（post）: 軽い操作は post_light の枠", async () => {
    scopes = ["read", "post"];
    appIssued = true;
    const calls: [string, () => Promise<Response>][] = [
      ["reactions", () => reactions(r("POST", { post_id: 7, emoji: "👍" }))],
      ["bookmarks", () => bookmarks(r("POST", { post_id: 7 }))],
      ["favorites", () => favAdd(r("POST", { user_id: "u" }))],
      ["pin", () => pin(r("POST"), P)],
      ["club", () => club(r("PATCH", { club: null }), P)],
      ["vote", () => vote(r("POST", { option_id: 1 }), P)],
    ];
    for (const [name, call] of calls) {
      rateKeys = [];
      const res = await call();
      expect(res.status, name).toBe(200);
      expect(bucketOf(), name).toBe("post_light");
    }
  });

  it("アプリの鍵: 投稿・削除は post の枠のまま", async () => {
    scopes = ["read", "post"];
    appIssued = true;
    await publish(r("POST", { text: "x" }));
    expect(bucketOf()).toBe("post");
    rateKeys = [];
    await del(r("DELETE"), P);
    expect(bucketOf()).toBe("post");
  });

  it("外部の鍵（write）: 軽い操作も削除も write の枠のまま", async () => {
    scopes = ["read", "write", "post"];
    appIssued = false;
    await bookmarks(r("POST", { post_id: 7 }));
    expect(bucketOf()).toBe("write");
    rateKeys = [];
    // お気に入りの付け外しはアプリの鍵だけ（外部の鍵は 403・§10.1）
    expect((await favAdd(r("POST", { user_id: "u" }))).status).toBe(403);
    rateKeys = [];
    await del(r("DELETE"), P);
    expect(bucketOf()).toBe("write");
    rateKeys = [];
    // リアクションは前から ["post","write"]（post を持てば post 側）。軽い枠になる
    await reactions(r("POST", { post_id: 7, emoji: "👍" }));
    expect(bucketOf()).toBe("post_light");
  });

  it("post_light は 61 回目でも通り、post は 61 回目で止まる", async () => {
    query.mockImplementation(async () => ({ rows: [{ count: 61, window_start: new Date() }] }));
    expect((await checkRateLimit(1, "post_light")).allowed).toBe(true);
    expect((await checkRateLimit(1, "post")).allowed).toBe(false);
    query.mockImplementation(async () => ({ rows: [{ count: 301, window_start: new Date() }] }));
    expect((await checkRateLimit(1, "post_light")).allowed).toBe(false);
  });
});
