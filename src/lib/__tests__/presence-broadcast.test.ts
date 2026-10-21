/** The presence SSE event carries the online list (so the Web stops re-fetching
 *  GET /api/presence per event) and bursts are coalesced into one broadcast. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const emitted = vi.hoisted(() => [] as unknown[]);
vi.mock("../live", () => ({ liveBus: { emit: (_n: string, e: unknown) => emitted.push(e) } }));
vi.mock("../display-name", () => ({
  resolveDisplayNames: async (emails: string[]) => new Map(emails.map((e) => [e, `name_${e.split("@")[0]}`])),
}));
vi.mock("../posts", () => ({ gravatarUrl: (e: string) => `/api/avatar/${e.length}` }));
vi.mock("../db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../user", () => ({
  emailToUserIds: async (emails: string[]) => new Map(emails.map((e) => [e.trim().toLowerCase(), `uid_${e.split("@")[0]}`])),
}));

async function fresh() {
  vi.resetModules();
  return await import("../presence");
}

describe("presence broadcast", () => {
  beforeEach(() => {
    emitted.length = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("coalesces a burst into one event that carries the member list", async () => {
    const p = await fresh();
    p.markOnline("a@example.com");
    p.markOnline("b@example.com");
    p.touch("a@example.com", false);
    p.touch("c@example.com", true);
    expect(emitted).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(p.PRESENCE_BROADCAST_MS);
    expect(emitted).toHaveLength(1);
    const ev = emitted[0] as { type: string; userIds: string[]; members: { userId: string; name: string; visible: boolean | null }[] };
    expect(ev.type).toBe("presence");
    expect(ev.userIds).toEqual(["uid_a", "uid_b", "uid_c"]);
    expect(ev.members).toEqual([
      { userId: "uid_a", name: "name_a", avatar: "/api/avatar/13", visible: false },
      { userId: "uid_b", name: "name_b", avatar: "/api/avatar/13", visible: null },
      { userId: "uid_c", name: "name_c", avatar: "/api/avatar/13", visible: true },
    ]);
    // No email anywhere in the payload.
    expect(JSON.stringify(ev)).not.toContain("@");
  });

  it("a later change gets its own event", async () => {
    const p = await fresh();
    p.markOnline("a@example.com");
    await vi.advanceTimersByTimeAsync(p.PRESENCE_BROADCAST_MS);
    p.touch("a@example.com", false);
    await vi.advanceTimersByTimeAsync(p.PRESENCE_BROADCAST_MS);
    expect(emitted).toHaveLength(2);
  });
});
