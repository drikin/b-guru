/** ★ Ghost が応答しなくても GET /api/agent/posts?include=display はすぐ返る（メンション無しで返す・QA 2026-10-22）。 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const listMembers = vi.fn(() => new Promise<never>(() => {})); // つながるが応答しない
const query = vi.fn(async (sql: unknown) => {
  const s = String(sql);
  if (s.includes("SELECT id, token_hash"))
    return { rows: [{ id: 901, email: "me@example.com", scopes: ["read"], device_name: "d", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date(), app_issued: false }] };
  if (s.includes("rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
  return { rows: [], rowCount: 0 };
});
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...(a as [unknown])) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...(a as [unknown])) } }));
vi.mock("@/lib/ghost", () => ({ listMembers: () => listMembers(), findMemberByEmail: async () => null, isPaidMember: () => true }));
vi.mock("../ghost", () => ({ listMembers: () => listMembers(), findMemberByEmail: async () => null, isPaidMember: () => true }));
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me" };
});
vi.mock("@/lib/posts", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    listPosts: async () => [{ id: 1, authorId: "u", isAuthor: false, authorName: "a", text: "@drikin こんにちは", images: [], createdAt: "2026-10-22T00:00:00Z" }],
  };
});
vi.mock("@/lib/club-visibility", () => ({ getHiddenClubs: async () => new Set() }));

import { GET } from "@/app/api/agent/posts/route";

describe("include=display と Ghost", () => {
  it("Ghost が応答しなくても 1 秒以内に返る（メンションは無しで返す）", async () => {
    const t0 = performance.now();
    const res = await GET(new NextRequest(new Request("http://x/api/agent/posts?include=display", { headers: { Authorization: "Bearer bga_x" } })));
    const elapsed = performance.now() - t0;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1_000);
    const b = await res.json();
    expect(b.posts[0].display.mention_ranges).toEqual([]);
    expect(listMembers).toHaveBeenCalledTimes(1); // 取りに行くのは裏で 1 本だけ
    // 2 回目も待たない・取り直しを重ねない
    const t1 = performance.now();
    await GET(new NextRequest(new Request("http://x/api/agent/posts?include=display", { headers: { Authorization: "Bearer bga_x" } })));
    expect(performance.now() - t1).toBeLessThan(1_000);
    expect(listMembers).toHaveBeenCalledTimes(1);
  });
});
