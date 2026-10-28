/**
 * camera（西田カメラの窓口）: 使える人・ログイン・鍵・自由文の制限・dk5090 への署名。
 * DB・Ghost・メール・fetch はモック（ほかの __tests__ と同じ）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import sharp from "sharp";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

const findMemberByEmail = vi.fn();
vi.mock("../ghost", async (orig) => ({
  GhostUnavailableError: ((await (orig as () => Promise<Record<string, unknown>>)()) as { GhostUnavailableError: unknown })
    .GhostUnavailableError,
  findMemberByEmail: (...a: unknown[]) => findMemberByEmail(...(a as [string])),
  isPaidMember: (m: any) => m.status === "paid",
}));

const sendEmail = vi.fn(async () => ({ message: "ok" }));
vi.mock("../mailgun", () => ({ sendEmail: (...a: unknown[]) => sendEmail(...(a as [])) }));

const hitLimit = vi.fn(async () => true);
vi.mock("../login", () => ({ hitLimit: (...a: unknown[]) => hitLimit(...(a as [])) }));

import {
  CameraError,
  cameraEligibility,
  cameraFreeTextFor,
  parseEditBody,
  relaySignature,
  requestCameraLogin,
  runCameraEdit,
  verifyCameraToken,
} from "../camera";

/** SQL の中の言葉で答えを決める小さな偽 DB。 */
let invites: Set<string>;
let tokenRow: Record<string, unknown> | null;
beforeEach(() => {
  query.mockReset();
  findMemberByEmail.mockReset();
  sendEmail.mockClear();
  hitLimit.mockReset();
  hitLimit.mockResolvedValue(true);
  invites = new Set();
  tokenRow = null;
  delete process.env.CAMERA_FREE_TEXT;
  query.mockImplementation(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("FROM camera_invites WHERE email")) return { rows: invites.has(params[0] as string) ? [{ "?column?": 1 }] : [] };
    if (sql.includes("INSERT INTO camera_login_requests")) return { rows: [{ id: 7 }] };
    if (sql.includes("FROM camera_tokens WHERE token_hash")) return { rows: tokenRow ? [tokenRow] : [] };
    if (sql.includes("FROM rate_limits")) return { rows: [] };
    return { rows: [], rowCount: 0 };
  });
});

describe("cameraEligibility", () => {
  it("会員は member、招待された人は guest、どちらでもなければ null", async () => {
    findMemberByEmail.mockResolvedValueOnce({ email: "a@x.jp", status: "paid" });
    expect(await cameraEligibility("a@x.jp")).toBe("member");
    findMemberByEmail.mockResolvedValueOnce(null);
    invites.add("g@x.jp");
    expect(await cameraEligibility("g@x.jp")).toBe("guest");
    findMemberByEmail.mockResolvedValueOnce({ email: "f@x.jp", status: "free" });
    expect(await cameraEligibility("f@x.jp")).toBeNull();
  });
});

describe("requestCameraLogin", () => {
  it("使えない人にはメールを送らない（返事は同じ）", async () => {
    findMemberByEmail.mockResolvedValue(null);
    await requestCameraLogin("nobody@x.jp", "1.2.3.4");
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("招待された会員でない人にはコードを送る（B-guru のログイン表は使わない）", async () => {
    findMemberByEmail.mockResolvedValue(null);
    invites.add("guest@x.jp");
    await requestCameraLogin("guest@x.jp", "1.2.3.4");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("login_requests") && !s.includes("camera_login_requests"))).toBe(false);
  });
  it("回数オーバーは 429", async () => {
    hitLimit.mockResolvedValueOnce(false);
    await expect(requestCameraLogin("a@x.jp", "1.2.3.4")).rejects.toMatchObject({ status: 429 });
  });
});

describe("verifyCameraToken", () => {
  const future = new Date(Date.now() + 86400_000).toISOString();
  it("鍵がなければ 401", async () => {
    await expect(verifyCameraToken(null, null)).rejects.toMatchObject({ status: 401 });
    await expect(verifyCameraToken("Bearer nope", null)).rejects.toMatchObject({ status: 401 });
  });
  it("招待を取り消された人の鍵はその場で失効", async () => {
    tokenRow = { id: 3, email: "g@x.jp", kind: "guest", expires_at: future, revoked_at: null, last_check: new Date().toISOString() };
    findMemberByEmail.mockResolvedValue(null);
    await expect(verifyCameraToken("Bearer t", null)).rejects.toMatchObject({ status: 401 });
    expect(query.mock.calls.some((c) => String(c[0]).includes("SET revoked_at = now() WHERE id = $1"))).toBe(true);
  });
  it("招待が生きていれば guest として通る", async () => {
    tokenRow = { id: 3, email: "g@x.jp", kind: "guest", expires_at: future, revoked_at: null, last_check: new Date().toISOString() };
    invites.add("g@x.jp");
    await expect(verifyCameraToken("Bearer t", null)).resolves.toMatchObject({ email: "g@x.jp", kind: "guest" });
  });
  it("退会した会員の鍵は確かめ直しのときに失効", async () => {
    tokenRow = { id: 4, email: "m@x.jp", kind: "member", expires_at: future, revoked_at: null, last_check: null };
    findMemberByEmail.mockResolvedValue({ email: "m@x.jp", status: "free" });
    await expect(verifyCameraToken("Bearer t", null)).rejects.toMatchObject({ status: 401 });
  });
});

describe("自由文", () => {
  it("未設定ならオーナーだけ", () => {
    expect(cameraFreeTextFor("drikin@gmail.com")).toBe(true);
    expect(cameraFreeTextFor("someone@x.jp")).toBe(false);
  });
  it("CAMERA_FREE_TEXT で指定した人だけ", () => {
    process.env.CAMERA_FREE_TEXT = "a@x.jp";
    expect(cameraFreeTextFor("a@x.jp")).toBe(true);
    expect(cameraFreeTextFor("drikin@gmail.com")).toBe(false);
  });
});

describe("parseEditBody", () => {
  const img = Buffer.alloc(200, 1).toString("base64");
  it("知らないプリセット・長すぎる文・対応外の縦横比は 400", () => {
    expect(() => parseEditBody({ image: img, preset: "evil" })).toThrow(CameraError);
    expect(() => parseEditBody({ image: img, prompt: "x".repeat(1001) })).toThrow(CameraError);
    expect(() => parseEditBody({ image: img, preset: "mandala", aspect: "2:1" })).toThrow(CameraError);
    expect(() => parseEditBody({ preset: "mandala" })).toThrow(CameraError);
  });
  it("プリセットがあれば自由文は捨てる", () => {
    expect(parseEditBody({ image: img, preset: "mandala", prompt: "x" })).toMatchObject({ preset: "mandala", prompt: null });
  });
});

describe("runCameraEdit", () => {
  let photo: Buffer;
  const realFetch = globalThis.fetch;
  beforeEach(async () => {
    photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#f00" } }).jpeg().toBuffer();
    process.env.PROMPTCAM_RELAY_URL = "https://dk5090.example:8443";
    process.env.PROMPTCAM_RELAY_KEY = "k".repeat(64);
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("会員でも自由文は断り、記録だけ残す", async () => {
    globalThis.fetch = vi.fn() as never;
    await expect(
      runCameraEdit({ tokenId: 1, email: "m@x.jp", kind: "member" }, { image: photo, preset: null, prompt: "make it nsfw", aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 403, code: "free_text_not_allowed" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO camera_log"))).toBe(true);
  });

  it("プリセットは署名つきで dk5090 に送り、JPEG を返す", async () => {
    const out = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      const body = init.body as Buffer;
      expect(h["X-PC-Sig"]).toBe(relaySignature("k".repeat(64), h["X-PC-User"], h["X-PC-Ts"], h["X-PC-Nonce"], body));
      expect(h["X-PC-User"]).not.toContain("@");
      const sent = JSON.parse(body.toString());
      expect(sent).toMatchObject({ preset: "mandala", aspect: "4:3" });
      expect(sent.prompt).toBeUndefined();
      return new Response(new Uint8Array(out), { headers: { "content-type": "image/jpeg", "x-seed": "42", "x-elapsed": "2.9" } });
    });
    globalThis.fetch = f as never;
    const r = await runCameraEdit({ tokenId: 1, email: "g@x.jp", kind: "guest" }, { image: photo, preset: "mandala", prompt: null, aspect: "4:3", seed: null });
    expect(f).toHaveBeenCalledTimes(1);
    expect(r.seed).toBe("42");
    expect(r.jpeg.equals(out)).toBe(true);
  });

  it("写真でないものは dk5090 に送らない", async () => {
    globalThis.fetch = vi.fn() as never;
    await expect(
      runCameraEdit({ tokenId: 1, email: "g@x.jp", kind: "guest" }, { image: Buffer.from("<svg onload=x>".repeat(20)), preset: "mandala", prompt: null, aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 400, code: "bad_image" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("回数オーバーは 429（dk5090 に送らない）", async () => {
    hitLimit.mockResolvedValue(false);
    globalThis.fetch = vi.fn() as never;
    await expect(
      runCameraEdit({ tokenId: 1, email: "g@x.jp", kind: "guest" }, { image: photo, preset: "mandala", prompt: null, aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 429 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("relaySignature", () => {
  it("dk5090 側（Python）と同じ値になる既知の例", () => {
    const body = Buffer.from('{"a":1}');
    const expected = crypto
      .createHmac("sha256", "secret")
      .update(["POST", "/v1/edit", "u1", "1700000000", "n1", crypto.createHash("sha256").update(body).digest("hex")].join("\n"))
      .digest("hex");
    expect(relaySignature("secret", "u1", "1700000000", "n1", body)).toBe(expected);
    expect(expected).toBe(RELAY_VECTOR);
  });
});

// promptcam_gateway.py の relay_signature("secret", "u1", "1700000000", "n1", b'{"a":1}') と同じ値。
const RELAY_VECTOR = "f64ccd2729a913e190fa8583e7e214cf19e57d19ee356de7fa879cb62e022417";
