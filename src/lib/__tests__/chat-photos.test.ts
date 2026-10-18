import { describe, it, expect } from "vitest";
import { fitWithin, photoSlots, imageFiles, CHAT_MAX_PHOTOS, CHAT_PHOTO_MAX_SIDE } from "../chat-photos";

describe("chat photos (client prep)", () => {
  it("scales the long side down to 1280 and never upscales", () => {
    expect(fitWithin(4032, 3024, CHAT_PHOTO_MAX_SIDE)).toEqual({ width: 1280, height: 960 });
    expect(fitWithin(3024, 4032, CHAT_PHOTO_MAX_SIDE)).toEqual({ width: 960, height: 1280 });
    expect(fitWithin(800, 600, CHAT_PHOTO_MAX_SIDE)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(10000, 1, CHAT_PHOTO_MAX_SIDE)).toEqual({ width: 1280, height: 1 });
  });

  it("caps attachments at 4", () => {
    expect(CHAT_MAX_PHOTOS).toBe(4);
    expect(photoSlots(0, 6)).toBe(4);
    expect(photoSlots(3, 2)).toBe(1);
    expect(photoSlots(4, 1)).toBe(0);
    expect(photoSlots(1, 2)).toBe(2);
  });

  it("keeps only image files", () => {
    const files = [
      new File(["x"], "a.jpg", { type: "image/jpeg" }),
      new File(["x"], "b.txt", { type: "text/plain" }),
      new File(["x"], "c.HEIC", { type: "" }),
    ];
    expect(imageFiles(files).map((f) => f.name)).toEqual(["a.jpg", "c.HEIC"]);
    expect(imageFiles(null)).toEqual([]);
  });
});
