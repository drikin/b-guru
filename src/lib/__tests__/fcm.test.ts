/**
 * Android（FCM）のプッシュ:
 *  - サービスアカウント JSON の読み込み（壊れていれば無効＝送らない）
 *  - OAuth 用の RS256 署名が公開鍵で検証できる
 *  - データは文字列だけ（aps は送らない・本文は載せない）
 *  - 「端末が消えた」の判定は UNREGISTERED だけ（404 や INVALID_ARGUMENT で端末を消さない）
 *  - 送信は Google の OAuth → FCM v1 の順。鍵が無ければ何もしない
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "crypto";
import {
  fcmConfigFromEnv,
  makeAssertion,
  toFcmData,
  isDeadFcmToken,
  sendFcm,
  __resetFcmForTests,
  FCM_TOKEN_RE,
} from "../fcm";
import { buildPushPayload } from "../push-notify";

const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const sa = { project_id: "bguru-chat", client_email: "fcm@bguru-chat.iam.gserviceaccount.com", private_key: pem };
const token = "c".repeat(22) + ":APA91b" + "x".repeat(140);

afterEach(() => {
  vi.unstubAllGlobals();
  __resetFcmForTests(undefined);
});

describe("FCM", () => {
  it("サービスアカウント JSON から設定を読む。壊れていれば null", () => {
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify(sa) })).toMatchObject({ projectId: "bguru-chat" });
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: "{}" })).toBeNull();
    expect(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: "not json" })).toBeNull();
    expect(fcmConfigFromEnv({})).toBeNull();
  });

  it("OAuth 用の署名は公開鍵で検証できる", () => {
    const cfg = fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify(sa) })!;
    const jwt = makeAssertion(cfg, 1_800_000_000);
    const [h, c, s] = jwt.split(".");
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s, "base64url"));
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(c, "base64url").toString());
    expect(claims).toMatchObject({ iss: sa.client_email, aud: "https://oauth2.googleapis.com/token", exp: 1_800_003_600 });
  });

  it("データは文字列だけ。aps と本文は送らない", () => {
    const data = toFcmData(buildPushPayload("chat_mention", { messageId: 42 }));
    expect(data).toEqual({ kind: "chat_mention", message_id: "42" });
  });

  it("端末が消えた判定は UNREGISTERED だけ（設定ミスの 404 で端末を消さない）", () => {
    expect(isDeadFcmToken({ status: 404, reason: "UNREGISTERED" })).toBe(true);
    expect(isDeadFcmToken({ status: 404, reason: "NOT_FOUND" })).toBe(false);
    expect(isDeadFcmToken({ status: 400, reason: "INVALID_ARGUMENT" })).toBe(false);
    expect(isDeadFcmToken({ status: 503 })).toBe(false);
  });

  it("鍵が無ければ送らない", async () => {
    __resetFcmForTests(null);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await sendFcm(token, { kind: "chat_new" })).toEqual({ status: 0, reason: "disabled" });
    expect(f).not.toHaveBeenCalled();
  });

  it("OAuth → FCM v1。高優先度・collapse_key 付き、トークンは使い回す", async () => {
    __resetFcmForTests(fcmConfigFromEnv({ FCM_SERVICE_ACCOUNT: JSON.stringify(sa) }));
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: unknown }) => {
      calls.push({ url, body: String(init.body) });
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "ya29.test" }), { status: 200 });
      return new Response("{}", { status: 200 });
    });
    expect((await sendFcm(token, { kind: "chat_new", message_id: "1" }, { collapseKey: "chat-new" })).status).toBe(200);
    expect((await sendFcm(token, { kind: "chat_new", message_id: "2" })).status).toBe(200);
    expect(calls.filter((c) => c.url.includes("oauth2"))).toHaveLength(1);
    const msg = JSON.parse(calls[1].body).message;
    expect(calls[1].url).toBe("https://fcm.googleapis.com/v1/projects/bguru-chat/messages:send");
    expect(msg).toMatchObject({ token, data: { kind: "chat_new", message_id: "1" }, android: { priority: "HIGH", collapse_key: "chat-new" } });
    expect(msg.notification).toBeUndefined();
  });

  it("トークンの形式", () => {
    expect(FCM_TOKEN_RE.test(token)).toBe(true);
    expect(FCM_TOKEN_RE.test("short")).toBe(false);
    expect(FCM_TOKEN_RE.test("a".repeat(120) + " ")).toBe(false);
  });
});
