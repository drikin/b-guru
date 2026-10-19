/** Room comings and goings in the chat (lib/voice-announce.ts): quiet, and not noisy —
 *  peeks say nothing, reconnects say nothing, everything shares one rewritten line. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/db", () => ({ pool: { query: vi.fn() } }));

import { announcementText, createVoiceAnnouncer, type VoiceAnnouncement } from "../voice-announce";

describe("timing: who gets announced", () => {
  let posted: VoiceAnnouncement[];
  let a: ReturnType<typeof createVoiceAnnouncer>;
  beforeEach(() => {
    vi.useFakeTimers();
    posted = [];
    a = createVoiceAnnouncer((x) => posted.push(x), 30_000, 60_000);
  });
  afterEach(() => vi.useRealTimers());

  it("announces coming in after a minute's stay, and leaving after the grace period", () => {
    a.joined("u1");
    vi.advanceTimersByTime(59_999);
    expect(posted).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(posted).toEqual([{ kind: "join", userId: "u1" }]);
    a.left("u1");
    vi.advanceTimersByTime(30_000);
    expect(posted.at(-1)).toEqual({ kind: "leave", userId: "u1" });
  });

  it("says nothing at all for a peek (in and out within the minute)", () => {
    a.joined("u1");
    vi.advanceTimersByTime(20_000);
    a.left("u1");
    vi.advanceTimersByTime(120_000);
    expect(posted).toEqual([]);
    expect(a.pending()).toBe(0);
  });

  it("says nothing for a reconnect (left and back within the grace period)", () => {
    a.joined("u1");
    vi.advanceTimersByTime(60_000);
    a.left("u1");
    vi.advanceTimersByTime(5_000);
    a.joined("u1");
    vi.advanceTimersByTime(120_000);
    expect(posted).toEqual([{ kind: "join", userId: "u1" }]);
  });

  it("announces a leave once even if LiveKit repeats it, and never for someone not announced", () => {
    a.left("ghost");
    a.joined("u1");
    vi.advanceTimersByTime(60_000);
    a.left("u1");
    a.left("u1");
    vi.advanceTimersByTime(30_000);
    expect(posted).toEqual([{ kind: "join", userId: "u1" }, { kind: "leave", userId: "u1" }]);
  });
});

describe("the text", () => {
  it("plain names (never an @mention), joined with ・, in and out on one line", () => {
    expect(announcementText(["mazzo"], [])).toBe("🎧 mazzo さんが部室に入りました");
    expect(announcementText(["NORIO TAKAHASHI", "takuto"], [])).toBe("🎧 NORIO TAKAHASHI さん・takuto さんが部室に入りました");
    expect(announcementText([], ["takuto"])).toBe("takuto さんが部室を出ました");
    expect(announcementText(["snize"], ["マツタク"])).toBe("🎧 snize さんが部室に入り、マツタク さんが出ました");
    expect(announcementText([], [])).toBeNull();
    expect(announcementText(["x"], [])).not.toContain("@");
  });
});

describe("the one rewritten line", () => {
  it("gathers comings and goings, nets out a come-and-go, deletes an empty line, restarts after a message", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    let latest = 0;
    const lines = new Map<number, string>();
    const deleted: number[] = [];
    vi.doMock("../chat", () => ({
      getLatestChatId: async () => latest,
      postChatNotice: async (body: string, updateId: number | null = null) => {
        if (updateId) {
          lines.set(updateId, body);
          return { id: updateId };
        }
        const id = ++latest;
        lines.set(id, body);
        return { id };
      },
      deleteChatMessage: async (id: number) => {
        lines.delete(id);
        deleted.push(id);
      },
    }));
    vi.doMock("../live", () => ({ emitLive: () => {} }));
    vi.doMock("../voice", () => ({ describeParticipants: async (ids: string[]) => ids.map((id) => ({ userId: id, name: id.toUpperCase() })) }));
    const mod = await import("../voice-announce");
    const settle = async () => {
      await vi.advanceTimersByTimeAsync(0);
      await mod.__announceSettled();
    };
    mod.voiceAnnouncer.joined("a");
    mod.voiceAnnouncer.joined("b");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect([...lines.values()]).toEqual(["🎧 A さん・B さんが部室に入りました"]);
    mod.voiceAnnouncer.left("b");
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(lines.get(1)).toBe("🎧 A さんが部室に入りました"); // B came and went within the line
    mod.voiceAnnouncer.left("a");
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(deleted).toEqual([1]); // nothing left to say
    latest = 5; // a message
    mod.voiceAnnouncer.joined("c");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    expect(lines.get(6)).toBe("🎧 C さんが部室に入りました");
    vi.doUnmock("../chat");
    vi.doUnmock("../live");
    vi.doUnmock("../voice");
    vi.useRealTimers();
  });
});
