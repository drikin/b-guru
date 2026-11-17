import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "os";
import path from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";
import sharp from "sharp";
import {
  __setVersionForTest,
  avatarPathForMd5,
  emailMd5,
  readCustomAvatar,
  renderAvatarSizes,
} from "../custom-avatar";
import { gravatarUrl } from "../posts";
import { sizedAvatarSrc } from "../avatar-size";

const md5 = emailMd5("Someone@Example.com ");
let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "avatar-test-"));
  process.env.CUSTOM_AVATAR_DIR = dir;
});
afterAll(async () => {
  __setVersionForTest(md5, null);
  delete process.env.CUSTOM_AVATAR_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe("自分で上げたアイコン", () => {
  it("上げていなければ今までどおりの URL、上げたら ?v=版 が付く", () => {
    expect(md5).toBe(emailMd5("someone@example.com"));
    expect(gravatarUrl("someone@example.com")).toBe(`/api/avatar/${md5}`);
    __setVersionForTest(md5, 1763250000000);
    expect(gravatarUrl("someone@example.com")).toBe(`/api/avatar/${md5}?v=1763250000000`);
    expect(avatarPathForMd5(md5)).toBe(`/api/avatar/${md5}?v=1763250000000`);
    __setVersionForTest(md5, null);
    expect(gravatarUrl("someone@example.com")).toBe(`/api/avatar/${md5}`);
  });

  it("大きさの指定は ?v= のあとに &s= で付く", () => {
    expect(sizedAvatarSrc(`/api/avatar/${md5}`, "md")).toBe(`/api/avatar/${md5}?s=120`);
    expect(sizedAvatarSrc(`/api/avatar/${md5}?v=12`, "md")).toBe(`/api/avatar/${md5}?v=12&s=120`);
    expect(sizedAvatarSrc(`/api/avatar/${md5}?v=12&x=1`, "md")).toBe(`/api/avatar/${md5}?v=12&x=1`);
  });

  it("横長の写真も正方形の JPEG にし、位置情報などを落とす", async () => {
    const png = await sharp({ create: { width: 900, height: 300, channels: 4, background: "#3366ff80" } })
      .withMetadata({ exif: { IFD0: { Copyright: "secret" } } })
      .png()
      .toBuffer();
    const sizes = await renderAvatarSizes(png);
    expect([...sizes.keys()].sort((a, b) => a - b)).toEqual([80, 120, 180, 250, 512]);
    const m = await sharp(sizes.get(512)!).metadata();
    expect(m.format).toBe("jpeg");
    expect(m.width).toBe(512);
    expect(m.height).toBe(512);
    expect(m.exif).toBeUndefined();
  });

  it("画像でないものは断る", async () => {
    await expect(renderAvatarSizes(Buffer.from("<svg onload=alert(1)>"))).rejects.toThrow();
    await expect(renderAvatarSizes(Buffer.from("not an image at all"))).rejects.toThrow();
  });

  it("配信は版がある人だけ、頼まれた大きさ以上の一番近いファイル", async () => {
    await writeFile(path.join(dir, `${md5}-120.jpg`), "s120");
    await writeFile(path.join(dir, `${md5}-512.jpg`), "s512");
    expect(await readCustomAvatar(md5, 120)).toBeNull(); // 版がない
    __setVersionForTest(md5, 5);
    expect(String(await readCustomAvatar(md5, 120))).toBe("s120");
    expect(String(await readCustomAvatar(md5, 1000))).toBe("s512");
    expect(await readCustomAvatar("../../etc/passwd", 120)).toBeNull();
    __setVersionForTest(md5, null);
  });
});
