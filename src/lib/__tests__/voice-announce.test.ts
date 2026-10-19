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

  it("writes plain names (never an @mention, so nobody gets pinged), gathered with ・", () => {
    expect(announcementText("open", ["mazzo"])).toBe("🎧 mazzo さんが部室に入りました");
    expect(announcementText("join", ["NORIO TAKAHASHI", "takuto"])).toBe("🎧 NORIO TAKAHASHI さん・takuto さんが部室に入りました");
    expect(announcementText("leave", ["takuto"])).toBe("takuto さんが部室を出ました");
    expect(announcementText("join", ["x"])).not.toContain("@");
  });
});

describe("the quiet notice line", () => {
  it("comings within a few minutes with nothing said in between share one line; a message starts a new one", async () => {
    vi.useRealTimers();
    vi.resetModules();
    let latest = 0;
    const lines: { id: number; body: string }[] = [];
    vi.doMock("../chat", () => ({
      getLatestChatId: async () => latest,
      postChatNotice: async (body: string, updateId: number | null = null) => {
        if (updateId) {
          lines.find((l) => l.id === updateId)!.body = body;
          return { id: updateId };
        }
        const id = ++latest;
        lines.push({ id, body });
        return { id };
      },
    }));
    vi.doMock("../voice", () => ({ describeParticipants: async (ids: string[]) => ids.map((id) => ({ userId: id, name: id.toUpperCase() })) }));
    const mod = await import("../voice-announce");
    mod.voiceAnnouncer.joined("a", true);
    mod.voiceAnnouncer.joined("b", false);
    await mod.__announceSettled();
    expect(lines).toEqual([{ id: 1, body: "🎧 A さん・B さんが部室に入りました" }]);
    latest = 5; // someone said something
    mod.voiceAnnouncer.joined("c", false);
    await mod.__announceSettled();
    expect(lines.at(-1)).toEqual({ id: 6, body: "🎧 C さんが部室に入りました" });
    vi.doUnmock("../chat");
    vi.doUnmock("../voice");
  });
});
