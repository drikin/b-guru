/** チャットの写真（drikin 2026-10-18）: 1 通 4 枚まで・チャット用にアップロードしたものだけ・
 *  写真だけのメッセージも可・古いアプリには本文「📷 写真」・24 時間でファイルも消える。 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, utimes, readdir, rm } from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/db", () => ({ pool: { query: vi.fn() } }));

import { normalizeChatInput, purgeExpiredChatFiles, CHAT_FILE_TTL_MS } from "../chat";
import { toAgentChatDto, CHAT_PHOTO_ONLY_BODY } from "../agent-chat";
import { LOCAL_IMAGE_RE } from "../publish";
import { handleUpload } from "../upload";

const img = (n: number) => `/api/media/chat-1792300000000-${String(n).padStart(12, "a")}.jpg`;

describe("normalizeChatInput", () => {
  it("写真だけ（本文なし）を受け付け、重複は 1 枚に", () => {
    expect(normalizeChatInput("", [img(1), img(1)])).toEqual({ ok: true, body: "", images: [img(1)] });
  });
  it("本文＋写真、写真なしの従来の送信もそのまま", () => {
    expect(normalizeChatInput(" やあ ", [img(1)])).toEqual({ ok: true, body: "やあ", images: [img(1)] });
    expect(normalizeChatInput("やあ", undefined)).toEqual({ ok: true, body: "やあ", images: [] });
  });
  it("空（本文も写真もなし）は従来どおり empty", () => {
    expect(normalizeChatInput("  ", [])).toEqual({ ok: false, error: "empty" });
  });
  it("5 枚以上・チャット用でない写真・外部 URL・文字列以外は拒否", () => {
    for (const bad of [[1, 2, 3, 4, 5].map(img), ["/api/media/1792-abc.jpg"], ["https://evil.example/x.jpg"],
      ["/api/media/chat-../../etc/passwd"], [42], "not-an-array"]) {
      expect(normalizeChatInput("x", bad)).toEqual({ ok: false, error: "bad images" });
    }
  });
});

describe("アプリ向け DTO", () => {
  const viewer = { userId: "me", mentionNames: new Set<string>() };
  it("写真だけのメッセージは本文に「📷 写真」（古いアプリで空の吹き出しにならない）", () => {
    const d = toAgentChatDto({ id: 1, body: "", images: [img(1)] }, viewer);
    expect(d.body).toBe(CHAT_PHOTO_ONLY_BODY);
    expect(d.images).toEqual([img(1)]);
  });
  it("写真のないメッセージは images: [] で本文そのまま", () => {
    const d = toAgentChatDto({ id: 2, body: "hi" }, viewer);
    expect(d).toMatchObject({ body: "hi", images: [] });
  });
});

describe("タイムライン投稿はチャットの写真を使えない（24 時間で消えるため）", () => {
  it("LOCAL_IMAGE_RE", () => {
    expect(LOCAL_IMAGE_RE.test("/api/media/1792-abc.jpg")).toBe(true);
    expect(LOCAL_IMAGE_RE.test(img(1))).toBe(false);
  });
});

describe("アップロードとファイルの削除", () => {
  let cwd: string;
  let tmp: string;
  beforeEach(async () => {
    cwd = process.cwd();
    tmp = await mkdtemp(path.join(os.tmpdir(), "chatimg-"));
    process.chdir(tmp);
  });
  afterEach(async () => {
    process.chdir(cwd);
    await rm(tmp, { recursive: true, force: true });
  });

  const upload = (n: number, bytes = 10) => {
    const form = new FormData();
    for (let i = 0; i < n; i++) form.append("images", new File([new Uint8Array(bytes)], `p${i}.jpg`, { type: "image/jpeg" }));
    // Content-Length like a real client (the route refuses requests without one).
    const req = new Request("http://x/api/chat/upload", { method: "POST", body: form, headers: { "content-length": "1000" } });
    return { req, form };
  };

  it("chat-… の名前で保存し、4 枚まで", async () => {
    const { req } = upload(2);
    const res = await handleUpload(req, "me@example.com", { chat: true });
    expect(res.status).toBe(201);
    const { urls } = await res.json();
    expect(urls).toHaveLength(2);
    for (const u of urls) expect(normalizeChatInput("", [u]).ok).toBe(true);
    const res5 = await handleUpload(upload(5).req, "me@example.com", { chat: true });
    expect(res5.status).toBe(400);
  });

  it("25 時間より古い chat-… だけ消す（タイムラインの写真や新しい写真は残す）", async () => {
    const dir = path.join(tmp, "public", "uploads");
    await mkdir(dir, { recursive: true });
    const now = Date.now();
    const old = (now - CHAT_FILE_TTL_MS - 60_000) / 1000;
    for (const n of ["chat-old.jpg", "chat-new.jpg", "1792-post.jpg"]) await writeFile(path.join(dir, n), "x");
    await utimes(path.join(dir, "chat-old.jpg"), old, old);
    await utimes(path.join(dir, "1792-post.jpg"), old, old);
    expect(await purgeExpiredChatFiles(now)).toBe(1);
    expect((await readdir(dir)).sort()).toEqual(["1792-post.jpg", "chat-new.jpg"]);
  });
});
