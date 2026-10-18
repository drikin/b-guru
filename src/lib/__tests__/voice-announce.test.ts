import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ pool: { query: vi.fn() } }));

import { announcementText, createVoiceAnnouncer, type VoiceAnnouncement } from "../voice-announce";

describe("voice room announcements in the chat", () => {
  let posted: VoiceAnnouncement[];
  let a: ReturnType<typeof createVoiceAnnouncer>;
  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    a = createVoiceAnnouncer((x) => posted.push(x), 30_000);
  });
  afterEach(() => vi.useRealTimers());

  it("announces opening the room, joining, and (after the grace period) leaving", () => {
    a.joined("u1", true);
    a.joined("u2", false);
    a.left("u2");
    expect(posted).toEqual([{ kind: "open", userId: "u1" }, { kind: "join", userId: "u2" }]);
    vi.advanceTimersByTime(29_999);
    expect(posted).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(posted[2]).toEqual({ kind: "leave", userId: "u2" });
  });

  it("says nothing for a reconnect (left and back within the grace period)", () => {
    a.joined("u1", true);
    a.left("u1");
    vi.advanceTimersByTime(5_000);
    a.joined("u1", true);
    vi.advanceTimersByTime(60_000);
    expect(posted).toEqual([{ kind: "open", userId: "u1" }]);
    expect(a.pending()).toBe(0);
  });

  it("announces a leave only once even if LiveKit repeats it", () => {
    a.left("u1");
    a.left("u1");
    vi.advanceTimersByTime(30_000);
    expect(posted).toEqual([{ kind: "leave", userId: "u1" }]);
  });

  it("writes plain names (never an @mention, so nobody gets pinged)", () => {
    expect(announcementText("open", "mazzo")).toBe("🎙️ mazzo さんがボイスルームを開きました");
    expect(announcementText("join", "NORIO TAKAHASHI")).toBe("🎙️ NORIO TAKAHASHI さんがボイスルームに入りました");
    expect(announcementText("leave", "takuto")).toBe("takuto さんがボイスルームを出ました");
    expect(announcementText("join", "x")).not.toContain("@");
  });
});
