/**
 * ネイティブチャット向け /api/agent/* ルートの統合テスト（DB・chat lib はモック、
 * ハンドラは実物）。重点:
 *  - スコープ: 送信/編集/リアクションは chat、既読は read_state（read だけでは 403）
 *  - privacy: email をレスポンス・ストリームに出さない
 *  - stream: presence に触れない（markOnline を呼ばない）・自分宛て通知だけが届く・
 *    1 トークンの同時接続上限
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

const markOnline = vi.fn();
vi.mock("@/lib/presence", () => ({
  markOnline: (...a: unknown[]) => markOnline(...a),
  markOffline: vi.fn(),
  ensurePresenceSweeper: vi.fn(),
  getOnlineUserIds: async () => ["uid_me", "uid_x"],
}));

const sendChatMessage = vi.fn();
const editChat = vi.fn();
const markChatRead = vi.fn();
vi.mock("@/lib/chat", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    ensureChatSweeper: vi.fn(),
    listChatMessages: async () => [
      { id: 7, authorId: "uid_x", isAuthor: false, authorName: "x", body: "@ドリキン やあ", createdAt: "2026-10-15T00:00:00Z", avatar: null, edited: false, editedAt: null },
    ],
    getUnreadCount: async () => 3,
    getLatestChatId: async () => 7,
    sendChatMessage: (...a: unknown[]) => sendChatMessage(...a),
    editChatMessageAndBroadcast: (...a: unknown[]) => editChat(...a),
    markChatRead: (...a: unknown[]) => markChatRead(...a),
  };
});
vi.mock("@/lib/members", () => ({
  mentionMembers: async () => [{ userId: "uid_x", name: "mazzo", avatar: "/api/avatar/abc" }],
}));
vi.mock("@/lib/reactions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    getReactions: async () => new Map([[7, [{ emoji: "❤️", count: 1, mine: true, reactors: ["ドリキン"] }]]]),
    toggleReaction: async () => ({ added: true, reactions: [] }),
  };
});

import { GET as chatGET, POST as chatPOST } from "@/app/api/agent/chat/route";
import { PATCH as chatPATCH } from "@/app/api/agent/chat/[id]/route";
import { POST as reactPOST } from "@/app/api/agent/chat/[id]/reactions/route";
import { POST as readPOST } from "@/app/api/agent/chat/read/route";
import { GET as streamGET } from "@/app/api/agent/stream/route";
import { GET as capsGET } from "@/app/api/agent/capabilities/route";
import { GET as summaryGET } from "@/app/api/agent/summary/route";
import { GET as membersGET } from "@/app/api/agent/members/route";
import { emitLive } from "@/lib/live";
import { emitPersonal } from "@/lib/personal-live";

let scopes: string[] = ["read"];
let tokenId = 1;
function authed(extra?: (s: string, params: unknown[]) => unknown) {
  query.mockImplementation(async (sql: unknown, params: unknown[] = []) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash"))
      return {
        rows: [{ id: tokenId, email: "me@example.com", scopes, device_name: "mac", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date() }],
      };
    if (s.includes("INSERT INTO rate_limits") || s.includes("FROM rate_limits"))
      return { rows: [{ count: 1, window_start: new Date() }] };
    const r = extra?.(s, params);
    if (r) return r;
    return { rows: [], rowCount: 0 };
  });
}
const H = { Authorization: "Bearer bga_x", "Content-Type": "application/json" };
const req = (url: string, init?: RequestInit) => new NextRequest(new Request(url, init));
const ctxId = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  scopes = ["read"];
  tokenId += 1;
  query.mockReset();
  markOnline.mockReset();
  sendChatMessage.mockReset();
  editChat.mockReset();
  markChatRead.mockReset();
});

describe("POST /api/agent/chat", () => {
  it("read だけのトークンは 403（chat スコープ必須）", async () => {
    authed();
    const res = await chatPOST(req("http://x/api/agent/chat", { method: "POST", headers: H, body: JSON.stringify({ body: "hi" }) }));
    expect(res.status).toBe(403);
    expect(sendChatMessage).not.toHaveBeenCalled();
  });

  it("chat スコープで 201・client_id を照合用に返す・email を含めない", async () => {
    scopes = ["read", "chat"];
    authed();
    sendChatMessage.mockResolvedValue({ id: 8, authorId: "uid_me", isAuthor: true, authorName: "ドリキン", body: "hi", createdAt: "t", avatar: null, edited: false, editedAt: null, clientId: "c1" });
    const res = await chatPOST(req("http://x/api/agent/chat", { method: "POST", headers: H, body: JSON.stringify({ body: " hi ", client_id: "c1" }) }));
    expect(res.status).toBe(201);
    expect(sendChatMessage).toHaveBeenCalledWith("me@example.com", "hi", "c1");
    const body = await res.json();
    expect(body.message).toMatchObject({ id: 8, is_author: true, client_id: "c1" });
    expect(JSON.stringify(body)).not.toContain("example.com");
  });

  it("空本文・不正な client_id", async () => {
    scopes = ["chat"];
    authed();
    expect((await chatPOST(req("http://x/api/agent/chat", { method: "POST", headers: H, body: JSON.stringify({ body: "  " }) }))).status).toBe(400);
    sendChatMessage.mockResolvedValue({ id: 9, authorId: "uid_me", isAuthor: true, authorName: null, body: "a", createdAt: "t", avatar: null, edited: false, editedAt: null });
    await chatPOST(req("http://x/api/agent/chat", { method: "POST", headers: H, body: JSON.stringify({ body: "a", client_id: "<x>" }) }));
    expect(sendChatMessage).toHaveBeenLastCalledWith("me@example.com", "a", null);
  });
});

describe("GET /api/agent/chat", () => {
  it("未読数・最新 ID・mentions_me・リアクション同梱", async () => {
    authed();
    const res = await chatGET(req("http://x/api/agent/chat?include=reactions", { headers: H }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ unread_count: 3, latest_id: 7 });
    expect(body.messages[0]).toMatchObject({ id: 7, is_author: false, mentions_me: true });
    expect(body.messages[0].reactions[0].emoji).toBe("❤️");
    expect(JSON.stringify(body)).not.toContain("example.com");
  });
});

describe("PATCH / reactions / read", () => {
  it("編集できないと 403", async () => {
    scopes = ["chat"];
    authed();
    editChat.mockResolvedValue(null);
    const res = await chatPATCH(req("http://x/api/agent/chat/5", { method: "PATCH", headers: H, body: JSON.stringify({ body: "fix" }) }), ctxId("5"));
    expect(res.status).toBe(403);
  });

  it("期限切れ・存在しないメッセージへのリアクションは 404", async () => {
    scopes = ["chat"];
    authed((s) => (s.includes("FROM chat_messages") ? { rows: [], rowCount: 0 } : null));
    const res = await reactPOST(req("http://x/api/agent/chat/5/reactions", { method: "POST", headers: H, body: JSON.stringify({ emoji: "❤️" }) }), ctxId("5"));
    expect(res.status).toBe(404);
  });

  it("既読は read_state 必須・最新 ID を超えて進めない", async () => {
    authed();
    expect((await readPOST(req("http://x/api/agent/chat/read", { method: "POST", headers: H, body: "{}" }))).status).toBe(403);
    scopes = ["read_state"];
    authed();
    const res = await readPOST(req("http://x/api/agent/chat/read", { method: "POST", headers: H, body: JSON.stringify({ last_read_id: 999 }) }));
    expect(res.status).toBe(200);
    expect(markChatRead).toHaveBeenCalledWith("me@example.com", 7);
  });
});

describe("入力の境界", () => {
  it("last_read_id が負数・文字列・int32 超は 400", async () => {
    scopes = ["read_state"];
    for (const v of [-1, "abc", 2 ** 31]) {
      authed();
      const res = await readPOST(req("http://x/api/agent/chat/read", { method: "POST", headers: H, body: JSON.stringify({ last_read_id: v }) }));
      expect(res.status).toBe(400);
    }
    expect(markChatRead).not.toHaveBeenCalled();
  });

  it("stream はクライアント IP を clientIp()（X-Real-IP 優先）で取る", async () => {
    const { readFile } = await import("fs/promises");
    const src = await readFile(new URL("../../app/api/agent/stream/route.ts", import.meta.url), "utf8");
    expect(src).toContain("clientIp(req)");
    expect(src).not.toMatch(/x-forwarded-for/i);
  });
});

describe("capabilities / summary", () => {
  it("capabilities はトークンのスコープを反映", async () => {
    scopes = ["read", "chat"];
    authed();
    const body = await (await capsGET(req("http://x/api/agent/capabilities", { headers: H }))).json();
    expect(body.features.chat.send).toBe(true);
    expect(body.features.chat.mark_read).toBe(false);
  });

  it("summary は数と最新通知だけ（email なし）", async () => {
    authed((s) => {
      if (s.includes("COUNT(*) AS c FROM notifications")) return { rows: [{ c: 2 }] };
      return null;
    });
    const body = await (await summaryGET(req("http://x/api/agent/summary", { headers: H }))).json();
    expect(body).toMatchObject({ chat: { unread_count: 3, latest_id: 7 }, notifications: { unread_count: 2 }, online_count: 2 });
    expect(JSON.stringify(body)).not.toContain("example.com");
  });
});

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, needle: string, max = 10): Promise<string> {
  const dec = new TextDecoder();
  let acc = "";
  for (let i = 0; i < max && !acc.includes(needle); i++) {
    const r = await reader.read();
    if (r.done) break;
    acc += dec.decode(r.value);
  }
  return acc;
}

describe("GET /api/agent/stream", () => {
  it("presence に触れず、ready → chat（閲覧者ごとの変換）→ 自分宛て通知だけが届く", async () => {
    authed();
    const ac = new AbortController();
    const res = await streamGET(req("http://x/api/agent/stream", { headers: H, signal: ac.signal }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    expect(await readUntil(reader, "event: ready")).toContain('"unread_count":3');

    emitLive({ type: "chat", action: "create", message: { id: 10, authorId: "uid_x", authorName: "x", body: "@ドリキン ねえ", createdAt: "t", avatar: null, edited: false, editedAt: null } });
    const chat = await readUntil(reader, "event: chat");
    expect(chat).toContain('"mentions_me":true');
    expect(chat).not.toContain("example.com");

    emitPersonal("other@example.com", { type: "notification", notification: { id: 1, type: "reply", actorId: "a", actorName: "a", isActor: false, postId: 1, replyId: 2, text: "他人宛て", readAt: null, createdAt: "t" } });
    emitPersonal("ME@example.com", { type: "notification", notification: { id: 2, type: "reply", actorId: "a", actorName: "a", isActor: false, postId: 1, replyId: 3, text: "自分宛て", readAt: null, createdAt: "t" } });
    const notif = await readUntil(reader, "自分宛て");
    expect(notif).toContain("自分宛て");
    expect(notif).not.toContain("他人宛て");

    expect(markOnline).not.toHaveBeenCalled();
    ac.abort();
    await reader.cancel();
  });

  it("並列に 4 本張っても上限を超えない（判定と予約が同期区間）", async () => {
    authed();
    const acs = [0, 1, 2, 3].map(() => new AbortController());
    const res = await Promise.all(acs.map((ac) => streamGET(req("http://x/api/agent/stream", { headers: H, signal: ac.signal }))));
    expect(res.filter((r) => r.status === 200)).toHaveLength(3);
    expect(res.filter((r) => r.status === 429)).toHaveLength(1);
    for (const ac of acs) ac.abort();
  });

  it("中断済みのリクエストは枠を消費しない", async () => {
    authed();
    const ac = new AbortController();
    ac.abort();
    await streamGET(req("http://x/api/agent/stream", { headers: H, signal: ac.signal }));
    const live = [0, 1, 2].map(() => new AbortController());
    const res = await Promise.all(live.map((a) => streamGET(req("http://x/api/agent/stream", { headers: H, signal: a.signal }))));
    expect(res.every((r) => r.status === 200)).toBe(true);
    for (const a of live) a.abort();
  });

  it("1 トークン 3 接続まで（4 本目は 429）", async () => {
    authed();
    const acs = [new AbortController(), new AbortController(), new AbortController()];
    const open = [];
    for (const ac of acs) open.push(await streamGET(req("http://x/api/agent/stream", { headers: H, signal: ac.signal })));
    expect(open.every((r) => r.status === 200)).toBe(true);
    const fourth = await streamGET(req("http://x/api/agent/stream", { headers: H }));
    expect(fourth.status).toBe(429);
    acs[0].abort();
    const again = await streamGET(req("http://x/api/agent/stream", { headers: H }));
    expect(again.status).toBe(200);
    for (const ac of acs) ac.abort();
    await again.body?.cancel();
  });
});

describe("GET /api/agent/members", () => {
  it("補完用の会員一覧（user_id・名前・アバターだけ、メールなし）", async () => {
    authed();
    const res = await membersGET(req("http://x/api/agent/members", { headers: H }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toEqual([{ user_id: "uid_x", name: "mazzo", avatar: "/api/avatar/abc" }]);
    expect(JSON.stringify(body)).not.toContain("@");
  });
});
