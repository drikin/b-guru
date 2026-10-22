/** lib/upload.ts の appMedia（アプリから画像・動画・音声）。Web と同じ形式の検査、画像は合計 50MB、動画・音声は 100MB。 */
import { describe, it, expect, vi } from "vitest";

vi.mock("fs/promises", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, mkdir: async () => undefined };
});

import { handleUpload } from "../upload";

function upload(fields: [string, Blob, string][], fakeLength: number) {
  const fd = new FormData();
  for (const [k, b, name] of fields) fd.append(k, b, name);
  const r = new Request("http://x/api/agent/upload", { method: "POST", body: fd });
  const h = new Headers(r.headers);
  h.set("content-length", String(fakeLength));
  return new Request(r, { headers: h, duplex: "half" } as RequestInit);
}
const MB = 1024 * 1024;

describe("handleUpload appMedia", () => {
  it("画像だけで合計 50MB を超えたら 413（今までのアプリと同じ）", async () => {
    const res = await handleUpload(upload([["images", new Blob(["x"], { type: "image/png" }), "a.png"]], 60 * MB), "me@x", { appMedia: true });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain("50MB");
  });

  it("101MB を超えるリクエストは 413", async () => {
    const res = await handleUpload(upload([["video", new Blob(["x"], { type: "video/mp4" }), "v.mp4"]], 102 * MB), "me@x", { appMedia: true });
    expect(res.status).toBe(413);
  });

  it("動画の形式は Web と同じ検査（avi は 400）", async () => {
    const res = await handleUpload(upload([["video", new Blob(["x"], { type: "video/x-msvideo" }), "v.avi"]], 90 * MB), "me@x", { appMedia: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("非対応の動画形式です: video/x-msvideo");
  });

  it("音声の形式は Web と同じ検査（text/plain は 400）", async () => {
    const res = await handleUpload(upload([["audio", new Blob(["x"], { type: "text/plain" }), "a.txt"]], 1 * MB), "me@x", { appMedia: true });
    expect(res.status).toBe(400);
  });

  it("imagesOnly（古いアプリの経路）は今までどおり動画を断る", async () => {
    const res = await handleUpload(upload([["video", new Blob(["x"], { type: "video/mp4" }), "v.mp4"]], 1 * MB), "me@x", { imagesOnly: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("画像だけ送れます");
  });
});

describe("大きなアップロードの同時数の上限（サーバ全体 3 本）", () => {
  it("10MB を超える解析中が 3 本なら 4 本目は 503（Retry-After）・終われば通る", async () => {
    const { MAX_CONCURRENT_BIG_UPLOADS, _bigUploadsInFlightForTest } = await import("../upload");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = () =>
      ({
        headers: new Headers({ "content-length": String(50 * MB) }),
        formData: async () => {
          await gate;
          throw new Error("x");
        },
      }) as unknown as Request;
    const running = Array.from({ length: MAX_CONCURRENT_BIG_UPLOADS }, () => handleUpload(slow(), "me@x", { appMedia: true }));
    await Promise.resolve();
    expect(_bigUploadsInFlightForTest()).toBe(3);
    const fourth = await handleUpload(slow(), "me@x", { appMedia: true });
    expect(fourth.status).toBe(503);
    expect(fourth.headers.get("Retry-After")).toBe("10");
    // 小さいアップロード（10MB 以下）とチャットの写真は数えない
    const small = await handleUpload(upload([["video", new Blob(["x"], { type: "video/x-msvideo" }), "v.avi"]], 1 * MB), "me@x", { appMedia: true });
    expect(small.status).toBe(400);
    release();
    await Promise.all(running);
    expect(_bigUploadsInFlightForTest()).toBe(0);
  });
});
