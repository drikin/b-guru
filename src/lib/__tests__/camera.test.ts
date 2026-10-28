/**
 * camera（西田カメラの窓口）: 使える人・ログイン・鍵・自由文の制限・dk5090 への署名。
 * DB・Ghost・メール・fetch はモック（ほかの __tests__ と同じ）。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
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

type RelayInit = { method: string; headers: Record<string, string>; body?: Buffer; onResponse?: () => void };
const relayHttp = vi.fn();
vi.mock("../camera-relay", () => ({ relayHttp: (...a: unknown[]) => relayHttp(...a) }));

import {
  CameraError,
  cameraEligibility,
  cameraJobStatus,
  cameraFreeTextFor,
  parseEditBody,
  relaySignature,
  requestCameraLogin,
  runCameraEdit,
  sanitizePhoto,
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
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).not.toHaveBeenCalled();
  });
  it("招待された会員でない人にはコードを送る（B-guru のログイン表は使わない）", async () => {
    findMemberByEmail.mockResolvedValue(null);
    invites.add("guest@x.jp");
    await requestCameraLogin("guest@x.jp", "1.2.3.4");
    await new Promise((r) => setTimeout(r, 10));
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => s.includes("login_requests") && !s.includes("camera_login_requests"))).toBe(false);
  });
  it("回数オーバーは 429", async () => {
    hitLimit.mockResolvedValueOnce(false);
    await expect(requestCameraLogin("a@x.jp", "1.2.3.4")).rejects.toMatchObject({ status: 429 });
  });
});

describe("requestCameraLogin の返事", () => {
  it("Ghost に届かなくても、使える人かどうかで返事を変えない", async () => {
    findMemberByEmail.mockRejectedValue(new Error("down"));
    await expect(requestCameraLogin("x@x.jp", "1.2.3.4")).resolves.toBeUndefined();
    invites.add("g@x.jp");
    await expect(requestCameraLogin("g@x.jp", "1.2.3.4")).resolves.toBeUndefined();
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
  it("待ちの表示の問い合わせ（touch=false）は期限を延ばす書き込みをしない", async () => {
    tokenRow = { id: 5, email: "m@x.jp", kind: "member", expires_at: future, revoked_at: null, last_check: new Date().toISOString() };
    await verifyCameraToken("Bearer t", null, false);
    expect(query.mock.calls.some((c) => String(c[0]).includes("SET last_used_at"))).toBe(false);
    await verifyCameraToken("Bearer t", null);
    expect(query.mock.calls.some((c) => String(c[0]).includes("SET last_used_at"))).toBe(true);
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
  it("番号（job）は形が合うときだけ受け取る", () => {
    expect(parseEditBody({ image: img, preset: "mandala", job: "0F8B2C1E-AAAA-4BBB-8CCC-123456789ABC" }).job).toBe(
      "0F8B2C1E-AAAA-4BBB-8CCC-123456789ABC"
    );
    expect(parseEditBody({ image: img, preset: "mandala", job: "../../etc" }).job).toBeNull();
    expect(parseEditBody({ image: img, preset: "mandala" }).job).toBeNull();
  });
});

describe("sanitizePhoto", () => {
  it("約 2.4MP・長辺 2048 までに縮め、小さい写真は大きくしない", async () => {
    const big = await sharp({ create: { width: 3024, height: 4032, channels: 3, background: "#123" } }).jpeg().toBuffer();
    const m = await sharp(await sanitizePhoto(big)).metadata();
    expect(m.width! * m.height!).toBeLessThanOrEqual(2_400_000 * 1.01);
    expect(m.width! * m.height!).toBeGreaterThan(2_300_000);
    expect(Math.round((m.width! / m.height!) * 100)).toBe(75);
    const wide = await sharp({ create: { width: 8000, height: 1000, channels: 3, background: "#123" } }).jpeg().toBuffer();
    expect((await sharp(await sanitizePhoto(wide)).metadata()).width).toBe(2048);
    const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#123" } }).jpeg().toBuffer();
    expect((await sharp(await sanitizePhoto(small)).metadata()).width).toBe(640);
  });
});

describe("runCameraEdit", () => {
  let photo: Buffer;
  beforeEach(async () => {
    photo = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#f00" } }).jpeg().toBuffer();
    process.env.PROMPTCAM_RELAY_URL = "https://dk5090.example:8443";
    process.env.PROMPTCAM_RELAY_KEY = "k".repeat(64);
    relayHttp.mockReset();
  });

  it("会員でも自由文は断り、記録だけ残す", async () => {
    await expect(
      runCameraEdit({ tokenId: 1, email: "m@x.jp", kind: "member" }, { image: photo, preset: null, prompt: "make it nsfw", aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 403, code: "free_text_not_allowed" });
    expect(relayHttp).not.toHaveBeenCalled();
    expect(query.mock.calls.some((c) => String(c[0]).includes("INSERT INTO camera_log"))).toBe(true);
  });

  it("プリセットは署名つきで dk5090 に送り、JPEG を返す", async () => {
    const out = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    relayHttp.mockImplementation(async (url: string, init: RelayInit) => {
      expect(url).toBe("https://dk5090.example:8443/v1/edit");
      const h = init.headers;
      const body = init.body as Buffer;
      expect(h["X-PC-Sig"]).toBe(relaySignature("k".repeat(64), h["X-PC-User"], h["X-PC-Ts"], h["X-PC-Nonce"], body));
      expect(h["X-PC-User"]).not.toContain("@");
      const sent = JSON.parse(body.toString());
      expect(sent).toMatchObject({ preset: "mandala", aspect: "4:3", job: "job-12345678" });
      expect(sent.prompt).toBeUndefined();
      init.onResponse?.();
      return { status: 200, headers: { "content-type": "image/jpeg", "x-seed": "42", "x-elapsed": "2.9" }, body: out };
    });
    const r = await runCameraEdit(
      { tokenId: 1, email: "g@x.jp", kind: "guest" },
      { image: photo, preset: "mandala", prompt: null, aspect: "4:3", seed: null, job: "job-12345678" }
    );
    expect(relayHttp).toHaveBeenCalledTimes(1);
    expect(r.seed).toBe("42");
    expect(r.jpeg.equals(out)).toBe(true);
  });

  it("写真でないものは dk5090 に送らない", async () => {
    await expect(
      runCameraEdit({ tokenId: 1, email: "g@x.jp", kind: "guest" }, { image: Buffer.from("<svg onload=x>".repeat(20)), preset: "mandala", prompt: null, aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 400, code: "bad_image" });
    expect(relayHttp).not.toHaveBeenCalled();
  });

  it("回数オーバーは 429（dk5090 に送らない）", async () => {
    hitLimit.mockResolvedValue(false);
    await expect(
      runCameraEdit({ tokenId: 1, email: "g@x.jp", kind: "guest" }, { image: photo, preset: "mandala", prompt: null, aspect: "4:3", seed: null })
    ).rejects.toMatchObject({ status: 429 });
    expect(relayHttp).not.toHaveBeenCalled();
  });

  it("待ちの表示: 自分の加工だけ、署名つきで dk5090 に聞き、届いた後は「受信中」", async () => {
    let finish!: () => void;
    let onResponse: (() => void) | undefined;
    const out = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0f0" } }).jpeg().toBuffer();
    relayHttp.mockImplementation(async (url: string, init: RelayInit) => {
      if (url.endsWith("/v1/edit")) {
        onResponse = init.onResponse;
        await new Promise<void>((r) => (finish = r));
        return { status: 200, headers: { "content-type": "image/jpeg" }, body: out };
      }
      expect(url).toBe("https://dk5090.example:8443/v1/status?job=job-abcdefgh");
      const h = init.headers;
      expect(h["X-PC-Sig"]).toBe(
        relaySignature("k".repeat(64), h["X-PC-User"], h["X-PC-Ts"], h["X-PC-Nonce"], Buffer.alloc(0), "GET", "/v1/status?job=job-abcdefgh")
      );
      return { status: 200, headers: {}, body: Buffer.from('{"phase":"queued","ahead":2,"eta":11.5,"typical":5,"extra":"<x>"}') };
    });
    const me = { tokenId: 1, email: "g@x.jp", kind: "guest" as const };
    const editing = runCameraEdit(me, { image: photo, preset: "mandala", prompt: null, aspect: "4:3", seed: null, job: "job-abcdefgh" });
    await new Promise((r) => setTimeout(r, 30));
    expect(await cameraJobStatus(me, "job-abcdefgh")).toEqual({ phase: "queued", ahead: 2, eta: 11.5, typical: 5 });
    // 他の人の番号・知らない番号は何も教えない（dk5090 にも聞かない）
    const calls = relayHttp.mock.calls.length;
    expect(await cameraJobStatus({ ...me, email: "x@x.jp" }, "job-abcdefgh")).toEqual({ phase: "unknown" });
    expect(await cameraJobStatus(me, "job-zzzzzzzz")).toEqual({ phase: "unknown" });
    expect(relayHttp.mock.calls.length).toBe(calls);
    onResponse?.();
    expect(await cameraJobStatus(me, "job-abcdefgh")).toEqual({ phase: "receiving" });
    finish();
    await editing;
    expect(await cameraJobStatus(me, "job-abcdefgh")).toEqual({ phase: "unknown" });
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
  it("待ちの表示の問い合わせ（GET /v1/status）も dk5090 側と同じ値", () => {
    expect(relaySignature("secret", "u1", "1700000000", "n1", Buffer.alloc(0), "GET", "/v1/status?job=abcdefgh")).toBe(STATUS_VECTOR);
  });
});

// promptcam_gateway.py の relay_signature("secret", "u1", "1700000000", "n1", b'{"a":1}') と同じ値。
const RELAY_VECTOR = "f64ccd2729a913e190fa8583e7e214cf19e57d19ee356de7fa879cb62e022417";
// promptcam_gateway.py の relay_signature("secret", "u1", "1700000000", "n1", b"", "GET", "/v1/status?job=abcdefgh")。
const STATUS_VECTOR = "9945e4fe8c74fe2624e0447f25dc15b4f93ab94d3adf842f58557d9de1039149";
