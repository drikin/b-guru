/**
 * POST /api/agent/posts の返事に via: "agent" が入る（本物の createPost の戻り値で確かめる）。
 * 以前は createPost の戻り値に via が無く、返事が via: null だった（チームレビュー 2026-10-22）。
 */
import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn(async (sql: string) => {
  const s = String(sql);
  if (s.includes("SELECT id, token_hash"))
    return { rows: [{ id: 7, email: "me@example.com", scopes: ["read", "write"], device_name: "agent", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date() }] };
  if (s.includes("rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
  return { rows: [], rowCount: 0 };
});
const clientQuery = vi.fn(async (sql: string) => {
  if (String(sql).includes("INSERT INTO posts")) return { rows: [{ id: 501, created_at: "2026-10-22T00:00:00.000Z" }] };
  return { rows: [], rowCount: 0 };
});
function makePool() {
  return { query: (...a: unknown[]) => query(...(a as [string])), connect: async () => ({ query: (...a: unknown[]) => clientQuery(...(a as [string])), release: () => {} }) };
}
vi.mock("@/lib/db", () => ({ pool: makePool() }));
vi.mock("../db", () => ({ pool: makePool() }));
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => null }));
vi.mock("@/lib/ghost", () => ({ findMemberByEmail: async () => null, isPaidMember: () => true, listMembers: async () => [] }));
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me", emailToUserId: async () => "uid_me", emailToUserIds: async () => new Map() };
});

import { POST } from "@/app/api/agent/posts/route";
import { createPost } from "@/lib/posts";

describe("via を返す", () => {
  it("createPost の戻り値に via", async () => {
    const p = await createPost({ authorEmail: "me@example.com", authorName: "me", text: "hi", via: "agent", noPreview: true });
    expect(p.via).toBe("agent");
    const human = await createPost({ authorEmail: "me@example.com", authorName: "me", text: "hi", noPreview: true });
    expect(human.via).toBeNull();
  });

  it("POST /api/agent/posts の返事が via: \"agent\"（一覧と同じ形）", async () => {
    const res = await POST(
      new NextRequest(new Request("http://x/api/agent/posts", { method: "POST", headers: { Authorization: "Bearer bga_x", "Content-Type": "application/json" }, body: JSON.stringify({ text: "こんにちは" }) }))
    );
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.post).toMatchObject({ id: 501, via: "agent", is_author: true, author_avatar: expect.stringMatching(/^\/api\/avatar\//) });
  });
});
