import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import { mkdtemp, writeFile, readFile, readdir, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createHash } from "crypto";
import { pickMediaWidth, shrinkProxyImage, imageInfo } from "../image-resize";
import { preparePostImage } from "../upload";
import { mediaVariant, isVariantCandidate, _resetMediaVariantsForTest } from "../media-variants";
import { mediaSized, mediaSrcSet, isSizableMedia } from "../media-url";

// An iPhone-like photo: 5712×4284 stored sideways (EXIF Orientation 6 = rotate
// 90° clockwise to view) with GPS in the EXIF. Left half red, right half blue,
// so after rotation the TOP must be red and the BOTTOM blue.
async function iphoneJpeg(): Promise<Buffer> {
  const W = 5712, H = 4284;
  const half = await sharp({ create: { width: W / 2, height: H, channels: 3, background: { r: 0, g: 0, b: 255 } } })
    .png()
    .toBuffer();
  return sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 0, b: 0 } } })
    .composite([{ input: half, left: W / 2, top: 0 }])
    .withExif({
      IFD0: { Make: "Apple", Model: "iPhone 17 Pro" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 39/1 0/1", GPSLongitudeRef: "E", GPSLongitude: "139/1 44/1 0/1" },
    })
    .withMetadata({ orientation: 6 })
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function pixel(buf: Buffer, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

let photo: Buffer;
beforeAll(async () => {
  photo = await iphoneJpeg();
}, 30_000);

describe("fixture really is a full-size photo with GPS", () => {
  it("has EXIF with GPS and orientation 6", async () => {
    const m = await sharp(photo).metadata();
    expect(m.width).toBe(5712);
    expect(m.height).toBe(4284);
    expect(m.orientation).toBe(6);
    expect(m.exif).toBeTruthy();
    expect(m.exif!.includes(Buffer.from("iPhone 17 Pro"))).toBe(true);
    // GPS IFD pointer tag 0x8825 (either byte order).
    expect(m.exif!.includes(Buffer.from([0x88, 0x25])) || m.exif!.includes(Buffer.from([0x25, 0x88]))).toBe(true);
  });
});

describe("preparePostImage (new uploads)", () => {
  it("stores ≤2048 on the long side, upright, with no EXIF/GPS", async () => {
    const { data, ext } = await preparePostImage(photo);
    expect(ext).toBe(".jpg");
    const m = await sharp(data).metadata();
    // Rotated: portrait 1536×2048.
    expect(m.width).toBe(1536);
    expect(m.height).toBe(2048);
    expect(m.exif).toBeUndefined();
    expect(m.orientation).toBeUndefined();
    expect(data.includes(Buffer.from("iPhone"))).toBe(false);
    // Orientation applied to the pixels: top red, bottom blue.
    const top = await pixel(data, 768, 100);
    const bottom = await pixel(data, 768, 1948);
    expect(top[0]).toBeGreaterThan(200);
    expect(top[2]).toBeLessThan(60);
    expect(bottom[2]).toBeGreaterThan(200);
    expect(bottom[0]).toBeLessThan(60);
    expect(data.byteLength).toBeLessThan(photo.byteLength / 3);
  });

  it("keeps a small, clean image byte-for-byte", async () => {
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#888" } }).jpeg().toBuffer();
    const { data, ext } = await preparePostImage(small);
    expect(ext).toBeUndefined();
    expect(data.equals(small)).toBe(true);
  });

  it("strips EXIF even from a small image", async () => {
    const small = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#888" } })
      .withExif({ IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 0/1 0/1" } })
      .jpeg()
      .toBuffer();
    const { data } = await preparePostImage(small);
    const m = await sharp(data).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.width).toBe(800);
  });

  it("stores a GIF (animation) as sent", async () => {
    const gif = await sharp({ create: { width: 3000, height: 3000, channels: 3, background: "#f00" } }).gif().toBuffer();
    const { data, ext } = await preparePostImage(gif);
    expect(ext).toBeUndefined();
    expect(data.equals(gif)).toBe(true);
  });

  it("stores unreadable bytes as sent instead of failing the upload", async () => {
    const junk = Buffer.from("not an image at all");
    const { data } = await preparePostImage(junk);
    expect(data.equals(junk)).toBe(true);
  });

  it("names a PNG sent as .jpg by its real format", async () => {
    const png = await sharp({ create: { width: 4000, height: 3000, channels: 4, background: "#0f0a" } }).png().toBuffer();
    const { ext } = await preparePostImage(png);
    expect(ext).toBe(".png");
  });
});

describe("mediaVariant (existing originals)", () => {
  let dir: string;
  let cache: string;
  const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bguru-media-"));
    cache = path.join(dir, "cache");
    process.env.BGURU_MEDIA_CACHE_DIR = cache;
    _resetMediaVariantsForTest();
  });
  afterAll(async () => {
    delete process.env.BGURU_MEDIA_CACHE_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it("serves sized, EXIF-free copies and never touches the original", async () => {
    const orig = path.join(dir, "1700000000000-abc.jpg");
    await writeFile(orig, photo);
    const before = sha(await readFile(orig));

    const def = await mediaVariant("1700000000000-abc.jpg", orig, null);
    expect(def).not.toBeNull();
    expect(def!.contentType).toBe("image/jpeg");
    const dm = await sharp(def!.path).metadata();
    expect(Math.max(dm.width!, dm.height!)).toBe(2048);
    expect(dm.exif).toBeUndefined();
    expect(dm.height).toBeGreaterThan(dm.width!); // upright portrait

    const v640 = await mediaVariant("1700000000000-abc.jpg", orig, "640");
    const m640 = await sharp(v640!.path).metadata();
    expect(Math.max(m640.width!, m640.height!)).toBe(640);
    expect(m640.exif).toBeUndefined();

    // Odd widths round up to an allowed size (no unbounded cache keys).
    const v700 = await mediaVariant("1700000000000-abc.jpg", orig, "700");
    expect(v700!.label).toBe("w1280");

    // Original untouched.
    expect(sha(await readFile(orig))).toBe(before);
    // Cached once per size.
    const files = (await readdir(cache)).filter((f) => !f.startsWith("."));
    expect(files.sort()).toEqual(
      ["1700000000000-abc.jpg__1280.jpg", "1700000000000-abc.jpg__2048.jpg", "1700000000000-abc.jpg__640.jpg"].sort()
    );

    // A fresh process (memory cleared) finds the cached file instead of re-encoding.
    _resetMediaVariantsForTest();
    const again = await mediaVariant("1700000000000-abc.jpg", orig, "640");
    expect(again!.path).toBe(v640!.path);
  }, 30_000);

  it("passes small clean images, chat photos and GIFs through", async () => {
    const small = path.join(dir, "1700000000001-def.jpg");
    await writeFile(small, await sharp({ create: { width: 600, height: 400, channels: 3, background: "#123" } }).jpeg().toBuffer());
    expect(await mediaVariant("1700000000001-def.jpg", small, null)).toBeNull();
    expect(await mediaVariant("1700000000001-def.jpg", small, "640")).toBeNull();

    expect(isVariantCandidate("chat-1700000000000-abc.jpg")).toBe(false);
    expect(await mediaVariant("chat-1.jpg", path.join(dir, "x"), "640")).toBeNull();
    expect(isVariantCandidate("1700000000000-abc.gif")).toBe(false);
    expect(isVariantCandidate("1700000000000-abc.mp4")).toBe(false);
  });

  it("falls back to the original for a broken file", async () => {
    const bad = path.join(dir, "1700000000002-bad.jpg");
    await writeFile(bad, "garbage");
    expect(await mediaVariant("1700000000002-bad.jpg", bad, null)).toBeNull();
  });
});

describe("pickMediaWidth", () => {
  it("rounds to the allowed sizes", () => {
    expect(pickMediaWidth(null)).toBeNull();
    expect(pickMediaWidth("")).toBeNull();
    expect(pickMediaWidth("abc")).toBeNull();
    expect(pickMediaWidth("-5")).toBeNull();
    expect(pickMediaWidth("100")).toBe(320);
    expect(pickMediaWidth("640")).toBe(640);
    expect(pickMediaWidth("641")).toBe(1280);
    expect(pickMediaWidth("1280")).toBe(1280);
    expect(pickMediaWidth("2048")).toBe(2048);
    expect(pickMediaWidth("99999")).toBe(2048);
  });
});

describe("shrinkProxyImage (/api/img)", () => {
  it("shrinks a big PNG og:image to ≤1280 WebP", async () => {
    const png = await sharp({ create: { width: 2400, height: 1260, channels: 3, background: "#456" } })
      .composite([{ input: await sharp({ create: { width: 1200, height: 600, channels: 3, background: "#fa0" } }).png().toBuffer(), left: 100, top: 100 }])
      .png({ compressionLevel: 0 })
      .toBuffer();
    const out = await shrinkProxyImage(png, "image/png");
    expect(out.ct).toBe("image/webp");
    const info = await imageInfo(out.buf);
    expect(info.width).toBe(1280);
    expect(out.buf.byteLength).toBeLessThan(png.byteLength);
  });

  it("keeps JPEG as JPEG and strips EXIF", async () => {
    const out = await shrinkProxyImage(photo, "image/jpeg");
    expect(out.ct).toBe("image/jpeg");
    const m = await sharp(out.buf).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(1280);
    expect(m.exif).toBeUndefined();
  });

  it("passes SVG, GIF and junk through", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
    expect((await shrinkProxyImage(svg, "image/svg+xml")).buf).toBe(svg);
    const junk = Buffer.from("nope");
    expect((await shrinkProxyImage(junk, "image/png")).buf).toBe(junk);
  });
});

describe("media-url (Web srcset)", () => {
  it("sizes post images only", () => {
    expect(isSizableMedia("/api/media/1700000000000-abc.jpg")).toBe(true);
    expect(isSizableMedia("/api/media/chat-1700000000000-abc.jpg")).toBe(false);
    expect(isSizableMedia("/api/media/1700000000000-abc.gif")).toBe(false);
    expect(isSizableMedia("https://example.com/a.jpg")).toBe(false);
    expect(mediaSized("/api/media/a.png", 640)).toBe("/api/media/a.png?w=640");
    expect(mediaSized("/api/media/a.mp4", 640)).toBe("/api/media/a.mp4");
    expect(mediaSrcSet("/api/media/a.webp")).toBe("/api/media/a.webp?w=640 640w, /api/media/a.webp?w=1280 1280w");
    expect(mediaSrcSet("/api/media/chat-a.jpg")).toBeUndefined();
  });
});
