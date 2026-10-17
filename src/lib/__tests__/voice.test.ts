/**
 * ボイスルーム（pure 部分）:
 *  - LiveKit トークンの署名と中身（部屋・マイクだけ・identity = user_id・メールを含めない）
 *  - webhook の検証（署名・本文ハッシュ・期限・別キー）
 *  - 放送イベント → 個人ストリーム、capabilities の voice
 *  - 試行中の許可リスト
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { signAccessToken, verifyJwt, verifyWebhook, livekitHttpUrl, type LiveKitConfig } from "../livekit";
import { issueJoinToken, isOpenerPresent, joinGrant, overCap, voiceEnabledFor, VOICE_ROOM, VOICE_TOKEN_TTL_SEC } from "../voice";
import { liveToStreamEvent, agentCapabilities } from "../agent-chat";

const cfg: LiveKitConfig = { url: "wss://example.livekit.cloud", apiKey: "APIkey123", apiSecret: "s".repeat(40) };
const decode = (jwt: string) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));

describe("LiveKit トークン", () => {
  it("HS256 で署名され、自分の秘密鍵で検証できる", () => {
    const t = signAccessToken(cfg, { identity: "uid_a", ttlSec: 60, video: { room: "r", roomJoin: true } });
    expect(verifyJwt(cfg, t)).not.toBeNull();
    expect(verifyJwt({ ...cfg, apiSecret: "x".repeat(40) }, t)).toBeNull();
    expect(verifyJwt({ ...cfg, apiKey: "other" }, t)).toBeNull();
  });

  it("期限切れは通らない", () => {
    const t = signAccessToken(cfg, { ttlSec: 60, video: {}, nowSec: 1_000 });
    expect(verifyJwt(cfg, t, 1_030)).not.toBeNull();
    expect(verifyJwt(cfg, t, 1_061)).toBeNull();
  });

  it("alg を書き換えたトークンは通らない", () => {
    const t = signAccessToken(cfg, { ttlSec: 60, video: {} });
    const [, p, s] = t.split(".");
    const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    expect(verifyJwt(cfg, `${none}.${p}.${s}`)).toBeNull();
  });

  it("exp の無いトークン・ヘッダが null のトークンは通らない（例外も出さない）", () => {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const sign = (h: string, p: string) => crypto.createHmac("sha256", cfg.apiSecret).update(`${h}.${p}`).digest("base64url");
    const h = enc({ alg: "HS256", typ: "JWT" });
    const noExp = enc({ iss: cfg.apiKey, video: {} });
    expect(verifyJwt(cfg, `${h}.${noExp}.${sign(h, noExp)}`)).toBeNull();
    const nullHeader = enc(null);
    const p = enc({ iss: cfg.apiKey, exp: 9_999_999_999 });
    expect(() => verifyJwt(cfg, `${nullHeader}.${p}.${sign(nullHeader, p)}`)).not.toThrow();
    expect(verifyJwt(cfg, `${nullHeader}.${p}.${sign(nullHeader, p)}`)).toBeNull();
  });

  it("入室トークン: この部屋だけ・マイクだけ・データ送信なし・2 分・identity は user_id", () => {
    const t = issueJoinToken(cfg, "uid_abc", "ドリキン");
    const c = decode(t);
    expect(c.sub).toBe("uid_abc");
    expect(c.name).toBe("ドリキン");
    expect(c.iss).toBe(cfg.apiKey);
    expect(c.exp - c.nbf).toBe(VOICE_TOKEN_TTL_SEC + 10);
    expect(c.video).toEqual(joinGrant(VOICE_ROOM));
    expect(c.video.canPublishSources).toEqual(["microphone"]);
    expect(c.video.canPublishData).toBe(false);
    expect(c.video.roomAdmin).toBeUndefined();
    expect(JSON.stringify(c)).not.toMatch(/@/);
    expect(c.roomConfig).toEqual({ maxParticipants: 100, emptyTimeout: 60, departureTimeout: 20 });
  });

  it("wss → https に変換する", () => {
    expect(livekitHttpUrl("wss://a.livekit.cloud/")).toBe("https://a.livekit.cloud");
    expect(livekitHttpUrl("ws://localhost:7880")).toBe("http://localhost:7880");
  });
});

describe("webhook の検証", () => {
  const body = JSON.stringify({ event: "participant_joined", room: { name: VOICE_ROOM } });
  const authFor = (raw: string, c = cfg) => {
    const sha256 = crypto.createHash("sha256").update(raw).digest("base64");
    // LiveKit puts the body hash in the token claims (same signer as access tokens).
    const t = signAccessToken(c, { ttlSec: 300, video: {} });
    const [h, p] = t.split(".");
    const claims = { ...JSON.parse(Buffer.from(p, "base64url").toString()), sha256 };
    const p2 = Buffer.from(JSON.stringify(claims)).toString("base64url");
    const sig = crypto.createHmac("sha256", c.apiSecret).update(`${h}.${p2}`).digest("base64url");
    return `${h}.${p2}.${sig}`;
  };

  it("正しい署名と本文なら通る", () => {
    expect(verifyWebhook(cfg, body, authFor(body))).toBe(true);
  });
  it("本文が書き換えられていたら通らない", () => {
    expect(verifyWebhook(cfg, body.replace("joined", "left"), authFor(body))).toBe(false);
  });
  it("別の秘密鍵で署名されたものは通らない", () => {
    expect(verifyWebhook(cfg, body, authFor(body, { ...cfg, apiSecret: "z".repeat(40) }))).toBe(false);
  });
  it("Authorization が無ければ通らない", () => {
    expect(verifyWebhook(cfg, body, null)).toBe(false);
  });
});

describe("ストリームと capabilities", () => {
  it("voice イベントを snake_case で流し、メールを含めない", () => {
    const out = liveToStreamEvent(
      {
        type: "voice",
        state: {
          active: true,
          openedBy: "uid_a",
          startedAt: "2026-10-17T00:00:00.000Z",
          participants: [{ userId: "uid_a", name: "A", avatar: "/api/avatar/abc" }],
        },
      },
      { userId: "uid_b", mentionNames: new Set() }
    );
    expect(out).toEqual({
      event: "voice",
      data: {
        active: true,
        opened_by: "uid_a",
        started_at: "2026-10-17T00:00:00.000Z",
        participants: [{ user_id: "uid_a", name: "A", avatar: "/api/avatar/abc" }],
      },
    });
  });

  it("voice スコープが無いトークンは join=false（再ログインで付く）", () => {
    expect(agentCapabilities(["read", "chat"], { voice: true }).features.voice).toMatchObject({ enabled: true, join: false });
    expect(agentCapabilities(["read", "chat", "voice"], { voice: true }).features.voice).toMatchObject({ enabled: true, join: true });
    expect(agentCapabilities(["read", "chat", "voice"]).features.voice).toMatchObject({ enabled: false, join: false });
  });
});

describe("試行中の許可リスト", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.LIVEKIT_URL = cfg.url;
    process.env.LIVEKIT_API_KEY = cfg.apiKey;
    process.env.LIVEKIT_API_SECRET = cfg.apiSecret;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it("設定が無ければ誰も使えない", () => {
    delete process.env.LIVEKIT_API_SECRET;
    expect(voiceEnabledFor("a@example.com")).toBe(false);
  });
  it("許可リストが無ければ全員", () => {
    delete process.env.VOICE_ALLOW_EMAILS;
    expect(voiceEnabledFor("a@example.com")).toBe(true);
  });
  it("許可リストがあればその人だけ（大文字小文字は無視）", () => {
    process.env.VOICE_ALLOW_EMAILS = "A@example.com, b@example.com";
    expect(voiceEnabledFor("a@EXAMPLE.com")).toBe(true);
    expect(voiceEnabledFor("c@example.com")).toBe(false);
  });
});

describe("開いた人のモデレーション権限", () => {
  const state = (openedBy: string | null, ids: string[]) => ({
    active: ids.length > 0,
    openedBy,
    startedAt: null,
    participants: ids.map((userId) => ({ userId, name: null, avatar: null })),
  });
  it("今も部屋にいる開いた人だけ", () => {
    expect(isOpenerPresent(state("uid_a", ["uid_a", "uid_b"]), "uid_a")).toBe(true);
    expect(isOpenerPresent(state("uid_a", ["uid_b"]), "uid_a")).toBe(false); // 抜けた後は権限なし
    expect(isOpenerPresent(state("uid_a", ["uid_a", "uid_b"]), "uid_b")).toBe(false);
    expect(isOpenerPresent(state("uid_a", []), "uid_a")).toBe(false);
  });
});

describe("話せる人数の上限（サーバー側）", () => {
  it("上限以内なら誰もミュートしない", () => {
    const since = new Map<string, number>();
    expect(overCap(["a", "b"], since, 2, 1000)).toEqual([]);
  });
  it("あとから話し始めた人をミュートする（先に話していた人は残す）", () => {
    const since = new Map<string, number>();
    overCap(["a", "b"], since, 2, 1000);
    expect(overCap(["a", "b", "c"], since, 2, 2000)).toEqual(["c"]);
  });
  it("マイクを切った人は記録から外れ、次に話すときは新しい順番になる", () => {
    const since = new Map<string, number>();
    overCap(["a", "b"], since, 2, 1000);
    overCap(["b"], since, 2, 2000); // a がミュート
    expect(since.has("a")).toBe(false);
    expect(overCap(["b", "c", "a"], since, 2, 3000)).toEqual(["c"]); // c と a は同時刻 → 名前順で並べ、後ろの c
  });
});
