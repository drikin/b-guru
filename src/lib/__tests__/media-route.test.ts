/** GET /api/media/<name>: post images come back resized and EXIF-free (default
 *  long side 2048, ?w= for smaller), the original file is never changed, and
 *  chat photos / video keep being served as stored (with Range). */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import sharp from "sharp";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

vi.mock("@/lib/download-auth", () => ({ mediaAuthEmail: async () => "member@example.com" }));

import { GET } from "@/app/api/media/[filename]/route";
import { _resetMediaVariantsForTest } from "@/lib/media-variants";
import { handleUpload } from "@/lib/upload";
import { readdir } from "fs/promises";

let root: string;
let photo: Buffer;
const call = (name: string, q = "", headers: Record<string, string> = {}) =>
  GET(new NextRequest(`https://bsm.example/api/media/${name}${q}`, { headers }), { params: Promise.resolve({ filename: name }) });

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "bguru-media-route-"));
  vi.spyOn(process, "cwd").mockReturnValue(root);
  delete process.env.BGURU_MEDIA_CACHE_DIR;
  _resetMediaVariantsForTest();
  await mkdir(path.join(root, "public", "uploads"), { recursive: true });
  photo = await sharp({ create: { width: 4032, height: 3024, channels: 3, background: "#4a7" } })
    .withExif({ IFD0: { Model: "iPhone" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 0/1 0/1" } })
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile(path.join(root, "public", "uploads", "1700000000000-aaa.jpg"), photo);
  await writeFile(path.join(root, "public", "uploads", "chat-1700000000000-bbb.jpg"), photo);
  await writeFile(path.join(root, "public", "uploads", "1700000000000-ccc.mp4"), Buffer.alloc(1000, 1));
}, 30_000);
afterAll(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe("GET /api/media", () => {
  it("default: ≤2048, no EXIF, cached under data/media-cache, original untouched", async () => {
    const r = await call("1700000000000-aaa.jpg");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-media-variant")).toBe("w2048");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("cache-control")).toContain("private");
    const buf = Buffer.from(await r.arrayBuffer());
    const m = await sharp(buf).metadata();
    expect([m.width, m.height]).toEqual([2048, 1536]);
    expect(m.exif).toBeUndefined();
    expect(Number(r.headers.get("content-length"))).toBe(buf.length);
    expect((await readFile(path.join(root, "public", "uploads", "1700000000000-aaa.jpg"))).equals(photo)).toBe(true);
    expect((await readFile(path.join(root, "data", "media-cache", "1700000000000-aaa.jpg__2048.jpg"))).equals(buf)).toBe(true);
  });

  it("?w=640 gives the small copy", async () => {
    const r = await call("1700000000000-aaa.jpg", "?w=640");
    const m = await sharp(Buffer.from(await r.arrayBuffer())).metadata();
    expect(m.width).toBe(640);
    expect(m.exif).toBeUndefined();
  });

  it("chat photos and video are served as stored (Range still works)", async () => {
    const c = await call("chat-1700000000000-bbb.jpg", "?w=640");
    expect(c.headers.get("x-media-variant")).toBeNull();
    expect(Buffer.from(await c.arrayBuffer()).equals(photo)).toBe(true);
    const v = await call("1700000000000-ccc.mp4", "", { range: "bytes=0-9" });
    expect(v.status).toBe(206);
    expect(v.headers.get("content-range")).toBe("bytes 0-9/1000");
    expect(v.headers.get("x-content-type-options")).toBe("nosniff");
    expect(c.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("still refuses path tricks and missing files", async () => {
    expect((await call("..%2Fx.jpg")).status).toBe(400);
    expect((await call("nope.jpg")).status).toBe(404);
  });
});

describe("POST /api/upload (handleUpload) stores post images resized and EXIF-free", () => {
  it("web/app post upload", async () => {
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(photo)], "IMG_0001.JPG", { type: "image/jpeg" }));
    const res = await handleUpload(new Request("https://bsm.example/api/upload", { method: "POST", body: fd }), "member@example.com");
    expect(res.status).toBe(201);
    const { urls } = await res.json();
    expect(urls).toHaveLength(1);
    const name = String(urls[0]).replace("/api/media/", "");
    expect(name).toMatch(/^\d+-[0-9a-f]{12}\.jpg$/);
    const stored = await readFile(path.join(root, "public", "uploads", name));
    const m = await sharp(stored).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(2048);
    expect(m.exif).toBeUndefined();
    // Serving it needs no extra copy: already ≤2048 and clean.
    _resetMediaVariantsForTest();
    const r = await call(name);
    expect(r.headers.get("x-media-variant")).toBeNull();
    expect(Buffer.from(await r.arrayBuffer()).equals(stored)).toBe(true);
  });

  it("chat upload is stored as sent (unchanged behaviour)", async () => {
    const small = await sharp({ create: { width: 1280, height: 960, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.append("images", new File([new Uint8Array(small)], "c.jpg", { type: "image/jpeg" }));
    const req = new Request("https://bsm.example/api/chat/upload", { method: "POST", body: fd });
    const len = (await req.clone().arrayBuffer()).byteLength;
    const res = await handleUpload(
      new Request("https://bsm.example/api/chat/upload", { method: "POST", body: fd, headers: { "content-length": String(len) } }),
      "member@example.com",
      { chat: true }
    );
    expect(res.status).toBe(201);
    const { urls } = await res.json();
    const name = String(urls[0]).replace("/api/media/", "");
    expect(name.startsWith("chat-")).toBe(true);
    expect((await readFile(path.join(root, "public", "uploads", name))).equals(small)).toBe(true);
    expect((await readdir(path.join(root, "public", "uploads"))).length).toBeGreaterThan(3);
  });
});
