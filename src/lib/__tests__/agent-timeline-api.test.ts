/**
 * アプリのタイムライン（/api/agent/posts・publish・upload・read）の統合テスト。
 *  - include=reactions,read で reactions / unread（自分の投稿は未読にしない）を同梱。指定なしは従来どおり
 *  - アバターは同一オリジンのプロキシ（gravatar の URL＝メールのハッシュを出さない）
 *  - 投稿・アップロードは post スコープ必須（AI エージェント用の write とは別枠）。投稿は Web と同じ lib/publish.ts を通る
 *  - アプリからの画像は /api/media/… だけ（外部 URL は 400）
 *  - 既読はまとめて送れる
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => null }));
vi.mock("@/lib/ghost", () => ({ findMemberByEmail: async () => null, isPaidMember: () => true, listMembers: async () => [] }));
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me", emailToUserId: async () => "uid_me", emailToUserIds: async () => new Map() };
});

const post = (id: number, isAuthor = false) => ({
  id, authorId: "uid_x", isAuthor, authorName: "mazzo", authorAvatar: "https://www.gravatar.com/avatar/0123456789abcdef0123456789abcdef?d=mp",
  text: "hi", images: ["/api/media/a.jpg"], createdAt: "2026-10-16T00:00:00Z", likeCount: 0, replyCount: 0,
});
vi.mock("@/lib/posts", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    listPosts: async () => [post(10), post(11, true), post(12)],
    getPostThread: async () => ({ post: post(10), replies: [{ ...post(13), parentId: 10 }] }),
  };
});
vi.mock("@/lib/club-visibility", () => ({ getHiddenClubs: async () => new Set() }));
vi.mock("@/lib/reactions", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, getReactions: async () => new Map([[10, [{ emoji: "❤️", count: 2, mine: true, reactors: [] }]]]) };
});
const markPostsRead = vi.fn(async () => 2);
vi.mock("@/lib/read-state-server", () => ({
  getReadIdsForPosts: async () => [12],
  getUnreadReplyCounts: async () => new Map([[10, 3]]),
  markPostsRead: (...a: unknown[]) => markPostsRead(...(a as [])),
}));
const publishPost = vi.fn();
vi.mock("@/lib/publish", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, publishPost: (...a: unknown[]) => publishPost(...a) };
});
const handleUpload = vi.fn();
vi.mock("@/lib/upload", () => ({ handleUpload: (...a: unknown[]) => handleUpload(...a) }));

import { GET as postsGET } from "@/app/api/agent/posts/route";
import { GET as threadGET } from "@/app/api/agent/posts/[id]/route";
import { POST as publishPOST } from "@/app/api/agent/publish/route";
import { POST as uploadPOST } from "@/app/api/agent/upload/route";
import { POST as readPOST } from "@/app/api/agent/read/route";
import { LOCAL_IMAGE_RE } from "@/lib/publish";

let scopes: string[] = ["read"];
let tokenId = 100;
function authed() {
  query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("SELECT id, token_hash"))
      return { rows: [{ id: tokenId, email: "me@example.com", scopes, device_name: "iphone", expires_at: new Date(Date.now() + 86400_000), last_membership_check: new Date() }] };
    if (s.includes("rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
    return { rows: [], rowCount: 0 };
  });
}
const H = { Authorization: "Bearer bga_x", "Content-Type": "application/json" };
const req = (url: string, init?: RequestInit) => new NextRequest(new Request(url, init));

beforeEach(() => {
  scopes = ["read"];
  tokenId += 1;
  query.mockReset();
  publishPost.mockReset();
  handleUpload.mockReset();
  markPostsRead.mockClear();
});

describe("GET /api/agent/posts（アプリのタイムライン）", () => {
  it("include=reactions,read で reactions と unread。自分の投稿・既読は未読にしない", async () => {
    authed();
    const res = await postsGET(req("http://x/api/agent/posts?include=reactions,read", { headers: H }));
    const b = await res.json();
    const by = (id: number) => b.posts.find((p: { id: number }) => p.id === id);
    expect(by(10)).toMatchObject({ unread: true, reactions: [{ emoji: "❤️", count: 2, mine: true }] });
    expect(by(11)).toMatchObject({ unread: false, is_author: true, reactions: [] });
    expect(by(12).unread).toBe(false);
    // 新着返信の数（ルートのみ。無ければ 0）
    expect(by(10).unread_replies).toBe(3);
    expect(by(12).unread_replies).toBe(0);
  });

  it("include なしは従来の形（reactions / unread を付けない）", async () => {
    authed();
    const b = await (await postsGET(req("http://x/api/agent/posts", { headers: H }))).json();
    expect(b.posts[0].reactions).toBeUndefined();
    expect(b.posts[0].unread).toBeUndefined();
    expect(b.posts[0].unread_replies).toBeUndefined();
  });

  it("アバターは同一オリジンのプロキシ。メール・gravatar の URL を含めない", async () => {
    authed();
    const text = await (await postsGET(req("http://x/api/agent/posts", { headers: H }))).text();
    expect(text).toContain('"author_avatar":"/api/avatar/0123456789abcdef0123456789abcdef"');
    expect(text).not.toContain("gravatar.com");
    expect(text).not.toContain("@example.com");
  });

  it("スレッドも include に対応", async () => {
    authed();
    const res = await threadGET(req("http://x/api/agent/posts/10?include=read", { headers: H }), { params: Promise.resolve({ id: "10" }) });
    const b = await res.json();
    expect(b.post.unread).toBe(true);
    expect(b.replies[0]).toMatchObject({ id: 13, unread: true });
    expect(b.replies[0].unread_replies).toBeUndefined(); // 返信には付けない
  });
});

describe("POST /api/agent/publish・upload", () => {
  it("post スコープが無ければ 403（投稿もアップロードも。write だけのエージェントも不可）", async () => {
    scopes = ["read", "write"];
    authed();
    expect((await publishPOST(req("http://x/api/agent/publish", { method: "POST", headers: H, body: JSON.stringify({ text: "hi" }) }))).status).toBe(403);
    expect((await uploadPOST(req("http://x/api/agent/upload", { method: "POST", headers: H, body: "x" }))).status).toBe(403);
    expect(publishPost).not.toHaveBeenCalled();
    expect(handleUpload).not.toHaveBeenCalled();
  });

  it("Web と同じ publishPost を通る（アプリの画像はサーバー上のものだけ）", async () => {
    scopes = ["read", "post"];
    authed();
    publishPost.mockResolvedValue({ status: 201, body: { post: post(20, true) } });
    const res = await publishPOST(
      req("http://x/api/agent/publish", { method: "POST", headers: H, body: JSON.stringify({ text: "写真", images: ["/api/media/a.jpg"], parent_id: 10 }) })
    );
    expect(res.status).toBe(201);
    expect(publishPost).toHaveBeenCalledWith("me@example.com", { text: "写真", images: ["/api/media/a.jpg"], parentId: 10 }, { localImagesOnly: true });
    expect((await res.json()).post).toMatchObject({ id: 20, images: ["/api/media/a.jpg"] });
  });

  it("画像 URL の形: /api/media/<名前> だけ", () => {
    expect(LOCAL_IMAGE_RE.test("/api/media/1760-abc.jpg")).toBe(true);
    expect(LOCAL_IMAGE_RE.test("https://evil.example/x.jpg")).toBe(false);
    expect(LOCAL_IMAGE_RE.test("/api/media/../secret")).toBe(false);
  });

  it("アップロードは画像だけ（lib/upload に imagesOnly で渡す）", async () => {
    scopes = ["read", "post"];
    authed();
    handleUpload.mockResolvedValue(new Response(JSON.stringify({ urls: ["/api/media/b.jpg"] }), { status: 201 }));
    const res = await uploadPOST(req("http://x/api/agent/upload", { method: "POST", headers: { Authorization: "Bearer bga_x" }, body: "x" }));
    expect(res.status).toBe(201);
    expect(handleUpload.mock.calls[0][2]).toEqual({ imagesOnly: true });
    expect(await res.json()).toEqual({ urls: ["/api/media/b.jpg"] });
  });
});

describe("POST /api/agent/read（まとめて既読）", () => {
  it("post_ids で一括。read_state スコープ必須", async () => {
    authed();
    expect((await readPOST(req("http://x/api/agent/read", { method: "POST", headers: H, body: JSON.stringify({ post_ids: [1, 2] }) }))).status).toBe(403);
    scopes = ["read", "read_state"];
    authed();
    const res = await readPOST(req("http://x/api/agent/read", { method: "POST", headers: H, body: JSON.stringify({ post_ids: [1, 2] }) }));
    expect(res.status).toBe(200);
    expect(markPostsRead).toHaveBeenCalledWith("me@example.com", [1, 2]);
    expect((await res.json()).marked).toBe(2);
  });
});
