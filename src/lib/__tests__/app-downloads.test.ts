/**
 * Mac アプリ（ベータ）の配布: manifest の検証・会員限定・ファイル配信。
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";

const sessionEmail = vi.fn();
vi.mock("@/lib/session", () => ({ getSessionEmail: () => sessionEmail() }));
vi.mock("../session", () => ({ getSessionEmail: () => sessionEmail() }));
const verifyAgentToken = vi.fn();
vi.mock("../agent-auth", () => ({ verifyAgentToken: (...a: unknown[]) => verifyAgentToken(...a) }));

let dir = "";
let lib: typeof import("../app-downloads");
let dl: typeof import("@/app/api/download/mac/route");
let info: typeof import("@/app/api/download/mac/info/route");
let appcast: typeof import("@/app/api/download/mac/appcast.xml/route");
const R = (h: Record<string, string> = {}) => new Request("https://bsm.backspace.fm/x", { headers: h });

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "bguru-dl-"));
  process.env.BGURU_DOWNLOADS_DIR = dir;
  lib = await import("../app-downloads");
  dl = await import("@/app/api/download/mac/route");
  info = await import("@/app/api/download/mac/info/route");
  appcast = await import("@/app/api/download/mac/appcast.xml/route");
});

beforeEach(() => {
  sessionEmail.mockReset();
  verifyAgentToken.mockReset();
});

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
    expect((await dl.GET(R())).status).toBe(401);
    expect((await info.GET(R())).status).toBe(401);
  });

  it("配布が無ければ available:false / 404", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    expect(await (await info.GET(R())).json()).toEqual({ available: false });
    expect((await dl.GET(R())).status).toBe(404);
  });

  it("配布中なら版を返し、DMG をそのまま配る", async () => {
    sessionEmail.mockResolvedValue("me@example.com");
    const bytes = Buffer.from("fake-dmg-bytes");
    await writeFile(path.join(dir, "BguruChat-0.1.2.dmg"), bytes);
    await writeFile(
      path.join(dir, "mac.json"),
      JSON.stringify({ version: "0.1.2", file: "BguruChat-0.1.2.dmg", size: 1, sha256: "b".repeat(64) })
    );
    const i = await (await info.GET(R())).json();
    expect(i).toMatchObject({ available: true, version: "0.1.2", size: bytes.length });
    const res = await dl.GET(R());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="BguruChat-0.1.2.dmg"');
    expect(res.headers.get("content-type")).toBe("application/x-apple-diskimage");
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
  });
});

describe("appcast / アプリのトークン", () => {
  const SIG = "A".repeat(86) + "==";
  it("未ログイン・トークン無しは 401、無効なトークンも 401", async () => {
    sessionEmail.mockResolvedValue(null);
    expect((await appcast.GET(R())).status).toBe(401);
    verifyAgentToken.mockRejectedValue(new Error("bad"));
    expect((await appcast.GET(R({ Authorization: "Bearer bga_x" }))).status).toBe(401);
  });

  it("アプリのトークン（read スコープ）で appcast と DMG を取れる", async () => {
    sessionEmail.mockResolvedValue(null);
    verifyAgentToken.mockResolvedValue({ email: "me@example.com", scopes: ["read", "chat"] });
    await writeFile(
      path.join(dir, "mac.json"),
      JSON.stringify({ version: "0.1.2", build: "202610151425", edSignature: SIG, notes: "a < b & c", file: "BguruChat-0.1.2.dmg" })
    );
    const res = await appcast.GET(R({ Authorization: "Bearer bga_x" }));
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain("<sparkle:version>202610151425</sparkle:version>");
    expect(xml).toContain("<sparkle:shortVersionString>0.1.2</sparkle:shortVersionString>");
    expect(xml).toContain(`sparkle:edSignature="${SIG}"`);
    expect(xml).toContain('url="https://bsm.backspace.fm/api/download/mac?v=0.1.2"');
    expect(xml).toContain("a &lt; b &amp; c"); // notes escaped
    expect((await dl.GET(R({ Authorization: "Bearer bga_x" }))).status).toBe(200);
  });

  it("read スコープの無いトークンは不可", async () => {
    sessionEmail.mockResolvedValue(null);
    verifyAgentToken.mockResolvedValue({ email: "me@example.com", scopes: ["chat"] });
    expect((await dl.GET(R({ Authorization: "Bearer bga_x" }))).status).toBe(401);
  });

  it("署名かビルド番号が無い版は appcast に載せない（更新を出さない）", () => {
    const base = { version: "0.1.2", file: "BguruChat-0.1.2.dmg" };
    expect(lib.buildAppcast(lib.parseMacManifest({ ...base, build: "1" }), "https://x")).not.toContain("<item>");
    expect(lib.buildAppcast(lib.parseMacManifest({ ...base, edSignature: SIG }), "https://x")).not.toContain("<item>");
    expect(lib.buildAppcast(lib.parseMacManifest({ ...base, build: "1; DROP", edSignature: SIG }), "https://x")).not.toContain("<item>");
    expect(lib.buildAppcast(null, "https://x")).toContain("<channel>");
  });
});
