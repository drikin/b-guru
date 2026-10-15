/**
 * APNs（iPhone/iPad のプッシュ）:
 *  - プロバイダートークン（ES256 JWT）が Apple の形式どおりで、公開鍵で検証できる
 *  - 鍵が無い間は送信しない（本番の振る舞いを変えない）
 *  - ペイロードに本文を載せない
 *  - メンションされた人だけ・送信者本人は除く
 *  - 端末登録 API の入力検証とスコープ
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "crypto";
import { NextRequest } from "next/server";

const query = vi.fn();
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../display-name", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return {
    ...actual,
    resolveDisplayNames: async (emails: string[]) =>
      new Map(emails.map((e) => [e, e.startsWith("drikin") ? "ドリキン" : e.startsWith("mazzo") ? "mazzo" : null])),
  };
});
vi.mock("@/lib/user", async (orig) => {
  const actual = await (orig as () => Promise<Record<string, unknown>>)();
  return { ...actual, ensureUserId: async () => "uid_me" };
});

import { makeProviderToken, apnsConfigFromEnv, sendApns, isDeadToken, __resetApnsForTests } from "../apns";
import { buildPushPayload, mentionedRecipients, pushChatMessage, throttled, __resetThrottleForTests } from "../push-notify";
import { POST as registerPOST, DELETE as registerDELETE } from "@/app/api/agent/devices/push/route";

const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CFG = { keyPem: PEM, keyId: "ABCDE12345", teamId: "F9349EVF2K", topic: "fm.backspace.bguru.chat" };

beforeEach(() => {
  query.mockReset();
  __resetApnsForTests(undefined);
});

describe("provider token (JWT ES256)", () => {
  it("header に kid、claims に iss/iat。署名は raw r||s で公開鍵検証できる", () => {
    const jwt = makeProviderToken(CFG, 1_700_000_000);
    const [h, c, s] = jwt.split(".");
    const dec = (x: string) => JSON.parse(Buffer.from(x, "base64url").toString());
    expect(dec(h)).toEqual({ alg: "ES256", kid: "ABCDE12345" });
    expect(dec(c)).toEqual({ iss: "F9349EVF2K", iat: 1_700_000_000 });
    const sig = Buffer.from(s, "base64url");
    expect(sig.length).toBe(64); // P-256 r||s
    expect(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, sig)).toBe(true);
  });

  it("設定: 鍵か Key ID が無ければ無効（null）", () => {
    expect(apnsConfigFromEnv({})).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY: PEM })).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY: PEM, APNS_KEY_ID: "short" })).toBeNull();
    expect(apnsConfigFromEnv({ APNS_KEY: PEM, APNS_KEY_ID: "ABCDE12345" })).toMatchObject({ teamId: "F9349EVF2K" });
  });

  it("開発用（sandbox）の鍵が別にあればそちらを使い、無ければ本番の鍵", () => {
    const env = { APNS_KEY: PEM, APNS_KEY_ID: "PROD123456", APNS_SANDBOX_KEY: PEM, APNS_SANDBOX_KEY_ID: "SBOX123456" };
    expect(apnsConfigFromEnv(env, "production")?.keyId).toBe("PROD123456");
    expect(apnsConfigFromEnv(env, "sandbox")?.keyId).toBe("SBOX123456");
    expect(apnsConfigFromEnv({ APNS_KEY: PEM, APNS_KEY_ID: "PROD123456" }, "sandbox")?.keyId).toBe("PROD123456");
    expect(apnsConfigFromEnv({ APNS_SANDBOX_KEY: PEM, APNS_SANDBOX_KEY_ID: "SBOX123456" }, "production")).toBeNull();
  });
});

describe("鍵が無い間は送らない", () => {
  it("sendApns は disabled、pushChatMessage は DB にも触れない", async () => {
    __resetApnsForTests(null);
    expect(await sendApns("a".repeat(64), "production", {})).toEqual({ status: 0, reason: "disabled" });
    expect(await pushChatMessage({ id: 1, body: "@ドリキン" }, "x@example.com")).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("410 / Unregistered / BadDeviceToken は端末を消す対象", () => {
    expect(isDeadToken({ status: 410 })).toBe(true);
    expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadToken({ status: 429, reason: "TooManyRequests" })).toBe(false);
  });
});

describe("ペイロード", () => {
  it("本文を載せず、ID と汎用文だけ。NSE で差し替えられる（mutable-content）", () => {
    const p = buildPushPayload("chat_mention", { messageId: 42 });
    expect(p).toMatchObject({ kind: "chat_mention", message_id: 42, aps: { "mutable-content": 1, category: "mention" } });
    expect(JSON.stringify(p)).not.toContain("@");
    const r = buildPushPayload("reply", { postId: 7, replyId: 8 });
    expect(r).toMatchObject({ post_id: 7, reply_id: 8, aps: { category: "reply", "thread-id": "post-7" } });
  });
});

describe("宛先", () => {
  const devices = [
    { email: "drikin@example.com", apnsToken: "a".repeat(64), environment: "production" as const },
    { email: "mazzo@example.com", apnsToken: "b".repeat(64), environment: "production" as const },
  ];
  const owners = devices.map((d) => d.email);
  it("メンションされた人だけ。送信者本人は除く", async () => {
    expect(await mentionedRecipients("@ドリキン 見て", "mazzo@example.com", owners)).toEqual(["drikin@example.com"]);
    expect(await mentionedRecipients("@mazzo @ドリキン", "drikin@example.com", owners)).toEqual(["mazzo@example.com"]);
    expect(await mentionedRecipients("ドリキンさん", "mazzo@example.com", owners)).toEqual([]);
  });

  it("同じ人への同じ種類の通知は 20 秒に 1 回（連投で連打しない）", () => {
    __resetThrottleForTests();
    expect(throttled("a@example.com", "chat_mention", 1000)).toBe(false);
    expect(throttled("a@example.com", "chat_mention", 5000)).toBe(true);
    expect(throttled("a@example.com", "reply", 5000)).toBe(false);
    expect(throttled("a@example.com", "chat_mention", 22_000)).toBe(false);
  });
});

describe("POST/DELETE /api/agent/devices/push", () => {
  const H = { Authorization: "Bearer bga_x", "Content-Type": "application/json" };
  const req = (method: string, body: unknown) =>
    new NextRequest(new Request("http://x/api/agent/devices/push", { method, headers: H, body: JSON.stringify(body) }));
  function authed() {
    query.mockImplementation(async (sql: unknown) => {
      const s = String(sql);
      if (s.includes("SELECT id, token_hash"))
        return {
          rows: [{ id: 21, email: "me@example.com", scopes: ["read"], device_name: "iPhone", expires_at: new Date(Date.now() + 864e5), last_membership_check: new Date() }],
        };
      if (s.includes("rate_limits")) return { rows: [{ count: 1, window_start: new Date() }] };
      return { rows: [], rowCount: 1 };
    });
  }

  it("正しい端末トークンと環境で登録（agent token に紐付く）", async () => {
    authed();
    const res = await registerPOST(req("POST", { token: "AB".repeat(32), environment: "sandbox" }));
    expect(res.status).toBe(200);
    const sqls = query.mock.calls.map((c) => String(c[0]));
    const ins = query.mock.calls.find((c) => String(c[0]).includes("INSERT INTO push_devices"))!;
    expect(ins[1]).toEqual(["me@example.com", 21, "ab".repeat(32), "sandbox", "ios"]);
    // 付け替えは同じ人か、元の持ち主のトークンが無効なときだけ
    expect(String(ins[0])).toMatch(/WHERE push_devices\.email = EXCLUDED\.email\s+OR NOT EXISTS/);
    // 同じ agent token の古い端末を消し、1 人 10 台まで
    expect(sqls.findIndex((q) => q.includes("WHERE agent_token_id = $1 AND apns_token <> $2"))).toBeLessThan(sqls.findIndex((q) => q.includes("INSERT INTO push_devices")));
    expect(sqls.some((q) => q.includes("ORDER BY updated_at DESC LIMIT $2"))).toBe(true);
  });

  it("不正なトークン・環境は 400、Bearer 無しは 401", async () => {
    authed();
    expect((await registerPOST(req("POST", { token: "xyz", environment: "production" }))).status).toBe(400);
    expect((await registerPOST(req("POST", { token: "a".repeat(64), environment: "staging" }))).status).toBe(400);
    const noAuth = new NextRequest(new Request("http://x/api/agent/devices/push", { method: "POST", body: "{}" }));
    expect((await registerPOST(noAuth)).status).toBe(401);
  });

  it("解除は本人の端末だけ", async () => {
    authed();
    expect((await registerDELETE(req("DELETE", { token: "c".repeat(64) }))).status).toBe(200);
    const del = query.mock.calls.find((c) => String(c[0]).includes("DELETE FROM push_devices"))!;
    expect(del[1]).toEqual(["me@example.com", "c".repeat(64)]);
  });
});
