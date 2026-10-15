/**
 * Mac アプリ（ベータ）の配布: manifest の検証・会員限定・ファイル配信。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const sessionEmail = vi.fn();
vi.mock("@/lib/session", () => ({ getSessionEmail: () => sessionEmail() }));

let dir = "";
let lib: typeof import("../app-downloads");
let dl: typeof import("@/app/api/download/mac/route");
let info: typeof import("@/app/api/download/mac/info/route");

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bguru-dl-"));
  process.env.BGURU_DOWNLOADS_DIR = dir;
  lib = await import("../app-downloads");
  dl = await import("@/app/api/download/mac/route");
  info = await import("@/app/api/download/mac/info/route");
});

beforeEach(() => sessionEmail.mockReset());

describe("parseMacManifest", () => {
  it("正しい manifest を受け入れる", () => {
    expect(lib.parseMacManifest({ version: "0.1.2", file: "BguruChat-0.1.2.dmg", size: 10, sha256: "a".repeat(64) }))
      .toMatchObject({ version: "0.1.2", file: "BguruChat-0.1.2.dmg", minimumSystemVersion: "14.0" });
  });
  it("ファイル名・版の形が違えば拒否（パス・トラバーサルも）", () => {
    for (const file of ["../etc/passwd", "BguruChat-0.1.2.dmg/../../x", "evil.dmg", "BguruChat-latest.dmg"]) {
      expect(lib.parseMacManifest({ version: "0.1.2", file })).toBeNull();
    }
    expect(lib.parseMacManifest({ version: "beta", file: "BguruChat-0.1.2.dmg" })).toBeNull();
    expect(lib.parseMacManifest(null)).toBeNull();
  });
});

describe("/api/download/mac", () => {
  it("未ログインは 401（情報もファイルも）", async () => {
    sessionEmail.mockResolvedValue(null);
    expect((await dl.GET()).status).toBe(401);
    expect((await info.GET()).status).toBe(401);
  });

  it("配布が無ければ available:false / 404", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    expect(await (await info.GET()).json()).toEqual({ available: false });
    expect((await dl.GET()).status).toBe(404);
  });

  it("配布中なら版を返し、DMG をそのまま配る", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    const bytes = Buffer.from("fake-dmg-bytes");
    await writeFile(path.join(dir, "BguruChat-0.1.2.dmg"), bytes);
    await writeFile(
      path.join(dir, "mac.json"),
      JSON.stringify({ version: "0.1.2", file: "BguruChat-0.1.2.dmg", size: 1, sha256: "b".repeat(64) })
    );
    const i = await (await info.GET()).json();
    expect(i).toMatchObject({ available: true, version: "0.1.2", size: bytes.length });
    const res = await dl.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="BguruChat-0.1.2.dmg"');
    expect(res.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });
});
