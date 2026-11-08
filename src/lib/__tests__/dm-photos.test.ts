import { describe, it, expect } from "vitest";
import { parseDmImages, DM_FILE_RE } from "../dm-media";
import { dmPreviewText } from "../dm-photos-client";

describe("✉️👥 DM の写真（純粋関数）", () => {
  it("parseDmImages: 形・枚数・重複", () => {
    expect(parseDmImages(undefined)).toEqual([]);
    expect(parseDmImages(null)).toEqual([]);
    expect(parseDmImages(["/api/media/dm-1-ab.jpg", "/api/media/dm-1-ab.jpg"])).toEqual(["/api/media/dm-1-ab.jpg"]);
    expect(parseDmImages("x")).toBeNull();
    expect(parseDmImages(["/api/media/chat-1-ab.jpg"])).toBeNull();
    expect(parseDmImages(["/api/media/dm-1-ab.svg"])).toBeNull();
    expect(parseDmImages(["/api/media/dm-../x.jpg"])).toBeNull();
    expect(parseDmImages([1])).toBeNull();
    expect(parseDmImages(Array.from({ length: 5 }, (_, i) => `/api/media/dm-${i}-a.jpg`))).toBeNull();
  });
  it("DM_FILE_RE: パスを含む名前は通さない", () => {
    expect(DM_FILE_RE.test("dm-1-abc.png")).toBe(true);
    expect(DM_FILE_RE.test("dm-1/../a.png")).toBe(false);
    expect(DM_FILE_RE.test("chat-1-abc.png")).toBe(false);
  });
  it("dmPreviewText: 本文が空で写真なら 📷 写真", () => {
    expect(dmPreviewText({ body: "", images: ["/api/media/dm-1-a.jpg"] })).toBe("📷 写真");
    expect(dmPreviewText({ body: "やあ", images: ["/api/media/dm-1-a.jpg"] })).toBe("やあ");
    expect(dmPreviewText({ body: "", images: [] })).toBe("");
    expect(dmPreviewText(null)).toBe("");
  });
});

describe("🐶 ビーグルへの写真の伝え方", async () => {
  const { photoNote } = await import("../gdm");
  it("写真だけ・本文と写真・写真なし", () => {
    expect(photoNote("", ["/api/media/dm-1-a.jpg"])).toBe("（写真 1 枚・中身は見えません）");
    expect(photoNote("見て", ["/a", "/b"])).toBe("見て （写真 2 枚・中身は見えません）");
    expect(photoNote("やあ", [])).toBe("やあ");
    expect(photoNote("やあ", null)).toBe("やあ");
  });
});
