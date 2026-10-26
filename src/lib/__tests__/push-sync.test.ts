/**
 * 端末をまたぐ連携（docs/device-sync-spec.md）:
 *  - 既読が送った知らせに追いついたら、notify_sync の端末だけへ消す合図（background push）を 1 回
 *  - 追いついていない・送っていない範囲では合図を出さない（ストリームの sync は毎回出す）
 *  - 「スマホで続ける」は本人の notify_sync 端末だけ、静かな時間でも送り、5 分で期限切れ
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type Sent = { token: string; payload: Record<string, unknown>; opts: { collapseId?: string; pushType?: string; expirationSec?: number } };
const sent: Sent[] = [];
vi.mock("../apns", () => ({
  apnsEnabled: () => true,
  isDeadToken: () => false,
  sendApns: async (token: string, _env: string, payload: Record<string, unknown>, opts: Sent["opts"]) => {
    sent.push({ token, payload, opts });
    return { status: 200 };
  },
}));

type Dev = { email: string; apnsToken: string; environment: "production"; notifyMode: "all"; quietHours: boolean; notifySync: boolean; notifyShogi: boolean };
let devices: Dev[] = [];
vi.mock("../push-devices", () => ({
  pushDeviceOwners: async () => [...new Set(devices.map((d) => d.email))],
  activePushDevices: async (emails: string[] | null) => devices.filter((d) => !emails || emails.includes(d.email)),
  markPushSent: async () => {},
  removePushDevice: async () => {},
}));
vi.mock("../display-name", () => ({
  resolveDisplayNames: async (emails: string[]) => new Map(emails.map((e) => [e, e.split("@")[0]])),
}));
const personal: { email: string; ev: unknown }[] = [];
vi.mock("../personal-live", () => ({
  emitPersonal: (email: string, ev: unknown) => personal.push({ email, ev }),
}));

import {
  pushChatMessage,
  pushDm,
  pushVoiceHandoff,
  syncRead,
  takeCleared,
  __notePushedForTests,
  __resetSyncLedgerForTests,
  __resetThrottleForTests,
} from "../push-notify";

const dev = (email: string, notifySync: boolean, tag = ""): Dev => ({
  email,
  apnsToken: (email.replace(/[^a-z]/g, "") + tag).padEnd(64, "a"),
  environment: "production",
  notifyMode: "all",
  quietHours: true,
  notifySync,
  notifyShogi: true,
});
const syncs = () => sent.filter((s) => s.payload.kind === "read_sync");

beforeEach(() => {
  sent.length = 0;
  personal.length = 0;
  __resetThrottleForTests();
  __resetSyncLedgerForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T03:00:00Z")); // 12:00 JST
});
afterEach(() => vi.useRealTimers());

describe("既読で知らせを消す", () => {
  it("チャット: 送った id まで読んだら notify_sync の端末だけへ 1 回", async () => {
    devices = [dev("me@x.com", true, "new"), dev("me@x.com", false, "old")];
    await pushChatMessage({ id: 50, body: "こんにちは" }, "nori@x.com");
    sent.length = 0;

    await syncRead("me@x.com", { scope: "chat", up_to: 49 }); // まだ追いついていない
    expect(syncs()).toHaveLength(0);
    await syncRead("me@x.com", { scope: "chat", up_to: 50 });
    expect(syncs()).toHaveLength(1);
    expect(syncs()[0].token).toBe(dev("me@x.com", true, "new").apnsToken);
    expect(syncs()[0].opts.pushType).toBe("background");
    expect(syncs()[0].payload).toMatchObject({ aps: { "content-available": 1 }, kind: "read_sync", scope: "chat", up_to: 50 });

    await syncRead("me@x.com", { scope: "chat", up_to: 60 }); // 2 回目は覚えが無いので送らない
    expect(syncs()).toHaveLength(1);
    // ストリームの sync は毎回
    expect(personal.filter((p) => (p.ev as { type: string }).type === "sync")).toHaveLength(3);
  });

  it("送っていない範囲・ほかの人には合図を出さない", async () => {
    devices = [dev("me@x.com", true)];
    await syncRead("me@x.com", { scope: "chat", up_to: 100 });
    await syncRead("me@x.com", { scope: "reply_all" });
    expect(syncs()).toHaveLength(0);
  });

  it("DM は相手ごと", async () => {
    devices = [dev("me@x.com", true)];
    await pushDm("me@x.com", 7, "uid_a");
    await pushDm("me@x.com", 8, "uid_b");
    sent.length = 0;
    await syncRead("me@x.com", { scope: "dm", peer_id: "uid_a", up_to: 7 });
    expect(syncs().map((s) => s.payload.peer_id)).toEqual(["uid_a"]);
    expect(takeCleared("me@x.com", { scope: "dm", peer_id: "uid_b", up_to: 8 })).toEqual(["dm:uid_b"]);
  });

  it("返信は投稿ごと、全部既読でまとめて", () => {
    __notePushedForTests(["me@x.com"], "reply:1", 11);
    __notePushedForTests(["me@x.com"], "reply:2", 12);
    __notePushedForTests(["me@x.com"], "shogi:3", 3);
    expect(takeCleared("me@x.com", { scope: "reply_all" }).sort()).toEqual(["reply:1", "reply:2"]);
    expect(takeCleared("me@x.com", { scope: "shogi", game_id: 3 })).toEqual(["shogi:3"]);
  });

  it("3 日たった覚えは使わない", () => {
    __notePushedForTests(["me@x.com"], "offkai:9", 9);
    vi.setSystemTime(new Date("2026-10-28T04:00:00Z"));
    expect(takeCleared("me@x.com", { scope: "offkai", event_id: 9 })).toEqual([]);
  });
});

describe("スマホで続ける", () => {
  it("本人の notify_sync 端末だけへ、静かな時間でも、5 分で期限切れ", async () => {
    vi.setSystemTime(new Date("2026-10-25T17:00:00Z")); // 02:00 JST
    devices = [dev("me@x.com", true, "new"), dev("me@x.com", false, "old"), dev("you@x.com", true)];
    expect(await pushVoiceHandoff("me@x.com", "offkai", true, 4)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].token).toBe(dev("me@x.com", true, "new").apnsToken);
    expect(sent[0].payload).toMatchObject({ kind: "voice_handoff", target: "offkai", mic: true, event_id: 4 });
    expect(sent[0].opts).toMatchObject({ collapseId: "voice-handoff", pushType: "alert", expirationSec: 300 });
  });

  it("続けられる端末が無ければ 0、同じ機能は続けて押しても 1 件だけ", async () => {
    devices = [dev("me@x.com", false)];
    expect(await pushVoiceHandoff("me@x.com", "voice", false)).toBe(0);
    devices = [dev("me@x.com", true)];
    expect(await pushVoiceHandoff("me@x.com", "room", false)).toBe(1);
    expect(await pushVoiceHandoff("me@x.com", "room", false)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).not.toHaveProperty("event_id");
    // 別の機能なら送り直す
    expect(await pushVoiceHandoff("me@x.com", "voice", true)).toBe(1);
    expect(sent).toHaveLength(2);
  });
});
