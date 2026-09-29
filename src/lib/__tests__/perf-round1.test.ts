/**
 * Performance round 1 (2026-09-28) — behaviour contracts for each change, so
 * a later edit that silently undoes one fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  AVATAR_SIZES,
  DEFAULT_AVATAR_SIZE,
  pickAvatarSize,
  sizedAvatarSrc,
} from "../avatar-size";
import { mdToHtml, __mdCacheForTests } from "../md";

const H = "d88553116c58cf161f670f800c8c7a0f";

describe("avatar sizing", () => {
  it("timeline avatars ask the proxy for a small image, not the 250px original", () => {
    expect(sizedAvatarSrc(`/api/avatar/${H}`, "sm")).toBe(`/api/avatar/${H}?s=80`);
    expect(sizedAvatarSrc(`/api/avatar/${H}`, "xs")).toBe(`/api/avatar/${H}?s=80`);
    expect(sizedAvatarSrc(`/api/avatar/${H}`, "md")).toBe(`/api/avatar/${H}?s=120`);
    expect(sizedAvatarSrc(`/api/avatar/${H}`, "lg")).toBe(`/api/avatar/${H}?s=180`);
  });

  it("every size the client requests is one the proxy accepts", () => {
    for (const s of ["xs", "sm", "md", "lg"] as const) {
      const n = Number(new URL(sizedAvatarSrc(`/api/avatar/${H}`, s), "http://x").searchParams.get("s"));
      expect(AVATAR_SIZES).toContain(n);
      expect(pickAvatarSize(String(n))).toBe(n);
    }
  });

  it("leaves uploaded avatars and other URLs untouched", () => {
    for (const u of ["/api/media/abc.jpg", "/icon-192.png", "https://example.com/a.png", `/api/avatar/${H}?s=80`]) {
      expect(sizedAvatarSrc(u, "sm")).toBe(u);
    }
  });

  it("the proxy only forwards allow-listed sizes (no per-value cache blow-up)", () => {
    expect(pickAvatarSize("80")).toBe(80);
    for (const bad of [null, "", "81", "5000", "-1", "abc", "80.5"]) {
      expect(pickAvatarSize(bad)).toBe(DEFAULT_AVATAR_SIZE);
    }
  });
});

describe("mdToHtml memo", () => {
  beforeEach(() => __mdCacheForTests.clear());

  it("returns identical HTML from the cache (pure function)", () => {
    const md = "**太字** と [link](https://example.com)\n- a\n- b";
    const first = mdToHtml(md);
    expect(__mdCacheForTests.size()).toBe(1);
    expect(mdToHtml(md)).toBe(first);
    expect(__mdCacheForTests.size()).toBe(1);
  });

  it("still sanitizes (cache must not bypass sanitize-lite)", () => {
    const html = mdToHtml('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    expect(html).not.toMatch(/onerror|<script/i);
    expect(mdToHtml('<img src=x onerror="alert(1)"> <script>alert(1)</script>')).toBe(html);
  });

  it("is bounded (long-lived tab / server process cannot grow it forever)", () => {
    for (let i = 0; i < __mdCacheForTests.max + 50; i++) mdToHtml(`post ${i}`);
    expect(__mdCacheForTests.size()).toBe(__mdCacheForTests.max);
  });

  it("evicts least-recently-used, keeping hot entries", () => {
    mdToHtml("hot");
    for (let i = 0; i < __mdCacheForTests.max - 1; i++) mdToHtml(`fill ${i}`);
    mdToHtml("hot"); // touch → most recent
    mdToHtml("one more"); // evicts the oldest, which is now "fill 0", not "hot"
    expect(__mdCacheForTests.has("hot")).toBe(true);
    expect(__mdCacheForTests.has("fill 0")).toBe(false);
  });
});

// ---- /api/posts limit clamp (real handler) ----
const listPosts = vi.fn(async (_o: { limit: number }) => []);
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => "someone@example.com" }));
vi.mock("@/lib/posts", async (orig) => ({
  ...(await orig<typeof import("../posts")>()),
  listPosts: (o: { limit: number }) => listPosts(o),
  listPinned: async () => [],
  listHotTopics: async () => [],
}));

describe("GET /api/posts limit", () => {
  beforeEach(() => listPosts.mockClear());
  const call = async (q: string) => {
    const { GET } = await import("../../app/api/posts/route");
    const { NextRequest } = await import("next/server");
    await GET(new NextRequest(`http://x/api/posts${q}`));
    return listPosts.mock.calls.at(-1)?.[0]?.limit;
  };

  it("caps an oversized limit (limit=100000 used to return every post)", async () => {
    expect(await call("?limit=100000")).toBe(100);
  });
  it("keeps normal page sizes", async () => {
    expect(await call("?limit=50")).toBe(50);
  });
  it("defaults when missing or junk", async () => {
    expect(await call("")).toBe(100);
    expect(await call("?limit=abc")).toBe(100);
    expect(await call("?limit=0")).toBe(1);
  });
});

// ---- housekeeping ----
const poolQuery = vi.fn(async (_sql: string) => ({ rowCount: 3 }));
vi.mock("@/lib/db", () => ({ pool: { query: (s: string) => poolQuery(s) } }));
vi.mock("../db", () => ({ pool: { query: (s: string) => poolQuery(s) } }));

describe("housekeeping", () => {
  it("only deletes EXPIRED sessions / otp codes", async () => {
    const { purgeExpiredAuthRows } = await import("../housekeeping");
    poolQuery.mockClear();
    const r = await purgeExpiredAuthRows();
    const sqls = poolQuery.mock.calls.map((c) => c[0].replace(/\s+/g, " "));
    expect(sqls).toEqual([
      "DELETE FROM sessions WHERE expires_at < now()",
      "DELETE FROM otp_codes WHERE expires_at < now()",
    ]);
    expect(r).toEqual({ sessions: 3, otp: 3 });
  });
});
