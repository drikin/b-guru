/**
 * 新着メッセージのプッシュ（iPhone/iPad、通知設定 "all"）:
 *  - 送信者本人には送らない
 *  - メンションされた人はメンション通知（新着とは別・重複させない）
 *  - "mentions" の端末には新着を送らない
 *  - 静かな時間（0:00〜7:00 JST・設定オン）は新着を送らない。メンションは送る
 *  - 同じ人への新着は 20 秒に 1 回、通知は 1 つにまとめて差し替え（collapse id）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent: { token: string; payload: { kind: string }; collapseId?: string }[] = [];
vi.mock("../apns", () => ({
  apnsEnabled: () => true,
  isDeadToken: () => false,
  sendApns: async (token: string, _env: string, payload: { kind: string }, opts: { collapseId?: string }) => {
    sent.push({ token, payload, collapseId: opts?.collapseId });
    return { status: 200 };
  },
}));

type Dev = { email: string; apnsToken: string; environment: "production"; notifyMode: "all" | "mentions"; quietHours: boolean };
let devices: Dev[] = [];
vi.mock("../push-devices", () => ({
  pushDeviceOwners: async () => [...new Set(devices.map((d) => d.email))],
  activePushDevices: async (emails: string[] | null) => devices.filter((d) => !emails || emails.includes(d.email)),
  markPushSent: async () => {},
  removePushDevice: async () => {},
}));
vi.mock("../display-name", () => ({
  resolveDisplayNames: async (emails: string[]) =>
    new Map(emails.map((e) => [e, e.startsWith("drikin") ? "ドリキン" : e.split("@")[0]])),
}));

import { pushChatMessage, isQuietHourJst, buildPushPayload, __resetThrottleForTests } from "../push-notify";

/** Which member a sent push went to. */
const who = (token: string) => devices.find((d) => d.apnsToken === token)?.email.split("@")[0];

const dev = (email: string, notifyMode: "all" | "mentions" = "all", quietHours = true): Dev => ({
  email,
  apnsToken: email.replace(/[^a-z]/g, "").padEnd(64, "a"),
  environment: "production",
  notifyMode,
  quietHours,
});

beforeEach(() => {
  sent.length = 0;
  __resetThrottleForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T03:00:00Z")); // 12:00 JST（静かな時間の外）
});
afterEach(() => vi.useRealTimers());

describe("新着メッセージのプッシュ", () => {
  it("送信者以外の all 端末に新着、メンションされた人にはメンション（重複なし）", async () => {
    devices = [dev("drikin@x.com"), dev("nori@x.com"), dev("mazzo@x.com")];
    await pushChatMessage({ id: 10, body: "@ドリキン 見て" }, "nori@x.com");
    const byKind = (k: string) => sent.filter((s) => s.payload.kind === k).map((s) => who(s.token));
    expect(byKind("chat_mention")).toEqual(["drikin"]);
    expect(byKind("chat_new")).toEqual(["mazzo"]);
    expect(sent.find((s) => s.payload.kind === "chat_new")?.collapseId).toBe("chat-new");
  });

  it("mentions 設定の端末には新着を送らない", async () => {
    devices = [dev("drikin@x.com", "mentions"), dev("mazzo@x.com")];
    await pushChatMessage({ id: 11, body: "こんにちは" }, "nori@x.com");
    expect(sent.map((s) => who(s.token))).toEqual(["mazzo"]);
  });

  it("静かな時間は新着を送らず、メンションは送る。静かな時間オフの端末には送る", async () => {
    vi.setSystemTime(new Date("2026-10-15T18:30:00Z")); // 03:30 JST
    devices = [dev("drikin@x.com"), dev("mazzo@x.com"), dev("night@x.com", "all", false)];
    await pushChatMessage({ id: 12, body: "@ドリキン 夜中にごめん" }, "nori@x.com");
    expect(sent.map((s) => `${s.payload.kind}:${who(s.token)}`).sort()).toEqual(["chat_mention:drikin", "chat_new:night"]);
  });

  it("同じ人への新着は 20 秒に 1 回", async () => {
    devices = [dev("mazzo@x.com")];
    await pushChatMessage({ id: 13, body: "1" }, "nori@x.com");
    await pushChatMessage({ id: 14, body: "2" }, "nori@x.com");
    vi.setSystemTime(new Date("2026-10-16T03:00:25Z"));
    await pushChatMessage({ id: 15, body: "3" }, "nori@x.com");
    expect(sent.length).toBe(2);
  });

  it("静かな時間の判定は JST", () => {
    expect(isQuietHourJst(new Date("2026-10-15T15:00:00Z"))).toBe(true); // 00:00 JST
    expect(isQuietHourJst(new Date("2026-10-15T21:59:00Z"))).toBe(true); // 06:59 JST
    expect(isQuietHourJst(new Date("2026-10-15T22:00:00Z"))).toBe(false); // 07:00 JST
  });

  it("新着のペイロードも本文を載せない", () => {
    const p = buildPushPayload("chat_new", { messageId: 9 });
    expect(p).toMatchObject({ kind: "chat_new", message_id: 9, aps: { category: "newmsg", "thread-id": "chat", "mutable-content": 1 } });
  });
});
