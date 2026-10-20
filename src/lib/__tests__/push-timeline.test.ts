/**
 * タイムラインの新着投稿のプッシュ（アプリの設定「タイムラインの新着」をオンにした端末だけ）:
 *  - オフの端末・投稿した本人には送らない
 *  - 静かな時間（0:00〜7:00 JST・設定オン）は送らない
 *  - 同じ人へは 20 秒に 1 回
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sent: { token: string; payload: Record<string, unknown>; collapseId?: string }[] = [];
vi.mock("../apns", () => ({
  apnsEnabled: () => true,
  isDeadToken: () => false,
  sendApns: async (token: string, _env: string, payload: Record<string, unknown>, opts: { collapseId?: string }) => {
    sent.push({ token, payload, collapseId: opts?.collapseId });
    return { status: 200 };
  },
}));

type Dev = { email: string; apnsToken: string; environment: "production"; notifyMode: "all"; quietHours: boolean; notifyTimeline: boolean };
let devices: Dev[] = [];
vi.mock("../push-devices", () => ({
  pushDeviceOwners: async () => [...new Set(devices.map((d) => d.email))],
  activePushDevices: async (emails: string[] | null) => devices.filter((d) => !emails || emails.includes(d.email)),
  markPushSent: async () => {},
  removePushDevice: async () => {},
}));

import { pushNewPost, buildPushPayload, __resetThrottleForTests } from "../push-notify";

const who = (token: string) => devices.find((d) => d.apnsToken === token)?.email.split("@")[0];
const dev = (email: string, notifyTimeline: boolean, quietHours = true): Dev => ({
  email,
  apnsToken: email.replace(/[^a-z]/g, "").padEnd(64, "a"),
  environment: "production",
  notifyMode: "all",
  quietHours,
  notifyTimeline,
});

beforeEach(() => {
  sent.length = 0;
  __resetThrottleForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T03:00:00Z")); // 12:00 JST
});
afterEach(() => vi.useRealTimers());

describe("タイムラインの新着投稿のプッシュ", () => {
  it("オンの端末だけ・本人以外に、投稿の id 付きで送る", async () => {
    devices = [dev("drikin@x.com", true), dev("nori@x.com", true), dev("mazzo@x.com", false)];
    await pushNewPost(77, "nori@x.com");
    expect(sent.map((s) => who(s.token))).toEqual(["drikin"]);
    expect(sent[0].payload).toMatchObject({ kind: "timeline_new", post_id: 77 });
    expect(sent[0].collapseId).toBe("post-77");
  });

  it("静かな時間は送らない（設定をオフにした端末には送る）", async () => {
    vi.setSystemTime(new Date("2026-10-16T17:00:00Z")); // 2:00 JST
    devices = [dev("drikin@x.com", true, true), dev("nori@x.com", true, false)];
    await pushNewPost(5, "someone@x.com");
    expect(sent.map((s) => who(s.token))).toEqual(["nori"]);
  });

  it("同じ人へは 20 秒に 1 回", async () => {
    devices = [dev("drikin@x.com", true)];
    await pushNewPost(1, "a@x.com");
    await pushNewPost(2, "a@x.com");
    vi.setSystemTime(new Date("2026-10-16T03:00:21Z"));
    await pushNewPost(3, "a@x.com");
    expect(sent.map((s) => s.payload.post_id)).toEqual([1, 3]);
  });

  it("通知の文は一般的なもの（本文はアプリが取りに行く）", () => {
    const p = buildPushPayload("timeline_new", { postId: 9 });
    expect(p.aps.alert).toEqual({ title: "B-guru タイムライン", body: "新しい投稿があります" });
    expect(p.aps.category).toBe("newpost");
    expect(p.aps["thread-id"]).toBe("timeline");
  });
});
