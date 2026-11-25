/**
 * アプリのキャッシュ用のチャットの取り方（after / from の window / ids / sig）と、
 * GET の ETag・304。DB と chat lib はモック、ハンドラは実物。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => null }));
vi.mock("@/lib/ghost", () => ({ findMemberByEmail: async () => null, isPaidMember: () => true }));
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me", emailToUserId: async () => "uid_me", emailToUserIds: async () => new Map() };
});
vi.mock("@/lib/display-name", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, resolveDisplayName: async () => "ドリキン", resolveDisplayNames: async () => new Map() };
});

type Msg = { id: number; body: string };
let store: Msg[] = [];
const listCalls: Record<string, unknown>[] = [];
vi.mock("@/lib/chat", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    ensureChatSweeper: vi.fn(),
    // The same filters as the SQL: newest first up to the limit, returned oldest first.
    listChatMessages: async (o: { after?: number; from?: number; to?: number; ids?: number[]; before?: number; limit?: number }) => {
      listCalls.push(o);
      const rows = store
        .filter((m) => (o.before === undefined || m.id < o.before) && (o.after === undefined || m.id > o.after))
        .filter((m) => (o.from === undefined || m.id >= o.from) && (o.to === undefined || m.id <= o.to))
        .filter((m) => !o.ids || o.ids.includes(m.id))
        .sort((a, b) => b.id - a.id)
        .slice(0, o.limit ?? 50)
        .reverse();
      return rows.map((m) => ({ id: m.id, authorId: "uid_x", isAuthor: false, authorName: "x", body: m.body, createdAt: "2026-11-25T00:00:00Z", avatar: null, edited: false, editedAt: null }));
    },
    getUnreadCount: async () => 0,
    getLatestChatId: async () => Math.max(0, ...store.map((m) => m.id)),
    getChatLastReadId: async () => null,
  };
});
vi.mock("@/lib/members", () => ({ mentionMembers: async () => [] }));
vi.mock("@/lib/reactions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, getReactions: async (_t: string, ids: number[]) => new Map(ids.map((id) => [id, []])) };
});

import { GET as chatGET } from "@/app/api/agent/chat/route";
import { agentJson } from "@/app/api/agent/_lib";

let tokenId = 100;
function authed() {
  query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash"))
      return { rows: [{ id: tokenId, email: "me@example.com", scopes: ["read"], device_name: "mac", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date() }] };
    if (s.includes("INSERT INTO rate_limits") || s.includes("FROM rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
    return { rows: [], rowCount: 0 };
  });
}
const H = { Authorization: "Bearer bga_x" };
const get = async (qs: string) => (await chatGET(new NextRequest(new Request(`http://x/api/agent/chat?${qs}`, { headers: H })))).json();

beforeEach(() => {
  tokenId += 1;
  query.mockReset();
  authed();
  listCalls.length = 0;
  store = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, body: `m${i + 1}` }));
});

describe("GET /api/agent/chat のキャッシュ用の取り方", () => {
  it("どのメッセージにも sig が付き、同じ中身なら同じ sig", async () => {
    const a = await get("include=reactions");
    const b = await get("include=reactions");
    expect(a.messages[0].sig).toMatch(/^[0-9a-f]{12}$/);
    expect(a.messages.map((m: { sig: string }) => m.sig)).toEqual(b.messages.map((m: { sig: string }) => m.sig));
    store[0].body = "直した";
    const c = await get("include=reactions");
    expect(c.messages[0].sig).not.toBe(a.messages[0].sig);
    expect(c.messages[1].sig).toBe(a.messages[1].sig);
  });

  it("after: それより新しいものだけ・window は持っている範囲の [id, sig]", async () => {
    const full = await get("include=reactions");
    store.push({ id: 11, body: "new" });
    store = store.filter((m) => m.id !== 5); // 消えた
    store[0].body = "編集"; // id 1
    const r = await get("include=reactions&after=10&from=1");
    expect(r.messages.map((m: { id: number }) => m.id)).toEqual([11]);
    expect(r.more).toBe(false);
    const win = new Map<number, string>(r.window);
    expect([...win.keys()]).toEqual([1, 2, 3, 4, 6, 7, 8, 9, 10]);
    const old = new Map<number, string>(full.messages.map((m: { id: number; sig: string }) => [m.id, m.sig]));
    const changed = [...win].filter(([id, sig]) => old.get(id) !== sig).map(([id]) => id);
    expect(changed).toEqual([1]);
  });

  it("after で上限を超えたら more: true（新しい方を返す）", async () => {
    const r = await get("after=2&limit=3");
    expect(r.more).toBe(true);
    expect(r.messages.map((m: { id: number }) => m.id)).toEqual([8, 9, 10]);
  });

  it("ids: その番号だけ（変な値は捨てる）", async () => {
    const r = await get("ids=3,x,7,-1,99");
    expect(r.messages.map((m: { id: number }) => m.id)).toEqual([3, 7]);
    expect(r.more).toBeUndefined();
    expect(r.window).toBeUndefined();
  });

  it("from だけ（after なし）は無視して今までどおりの全体", async () => {
    const r = await get("from=3");
    expect(r.messages).toHaveLength(10);
    expect(r.window).toBeUndefined();
  });
});

describe("agentJson の ETag・304", () => {
  const out = { status: 200, body: { a: 1 } };
  it("GET に ETag を付け、同じ If-None-Match なら本文なしの 304", async () => {
    const r1 = agentJson(out, new Request("http://x/", { method: "GET" }));
    const etag = r1.headers.get("ETag")!;
    expect(etag).toMatch(/^".+"$/);
    const r2 = agentJson(out, new Request("http://x/", { headers: { "If-None-Match": etag } }));
    expect(r2.status).toBe(304);
    expect(await r2.text()).toBe("");
    const r3 = agentJson({ status: 200, body: { a: 2 } }, new Request("http://x/", { headers: { "If-None-Match": etag } }));
    expect(r3.status).toBe(200);
  });
  it("req なし・POST・エラーには付けない", () => {
    expect(agentJson(out).headers.get("ETag")).toBeNull();
    expect(agentJson(out, new Request("http://x/", { method: "POST" })).headers.get("ETag")).toBeNull();
    expect(agentJson({ status: 404, body: {} }, new Request("http://x/")).headers.get("ETag")).toBeNull();
  });
});

describe("ストリームの新しいメッセージの sig", async () => {
  const { liveToStreamEvent, toAgentChatDto, withChatSig } = await import("@/lib/agent-chat");
  const viewer = { userId: "uid_me", mentionNames: new Set<string>() };
  const m = { id: 5, authorId: "uid_x", authorName: "x", body: "hi", createdAt: "t", avatar: null, edited: false, editedAt: null };
  it("create はリアクション空と sig 付き（一覧の sig と同じ）、edit は sig なし", () => {
    const c = liveToStreamEvent({ type: "chat", action: "create", message: m } as never, viewer)!;
    const msg = (c.data as { message: { sig?: string; reactions?: unknown[] } }).message;
    expect(msg.reactions).toEqual([]);
    expect(msg.sig).toBe(withChatSig(toAgentChatDto(m, viewer, [])).sig);
    const e = liveToStreamEvent({ type: "chat", action: "edit", message: m } as never, viewer)!;
    expect((e.data as { message: { sig?: string } }).message.sig).toBeUndefined();
  });
});
