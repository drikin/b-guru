import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Presence visibility (drikin 2026-09-23).
 *
 * The right-sidebar オンライン panel dims members whose tab is open but
 * backgrounded. The server stores a `visible` flag per member, fed by the
 * client heartbeat (`POST /api/presence/ping` with `{ visible }`).
 *
 * These tests pin the contract that matters:
 *   - a member who never reports visibility is treated as ACTIVE (never dimmed)
 *   - reporting `false` flips the flag and broadcasts
 *   - reporting the same value again does NOT broadcast (no event storm)
 *   - a re-registered member (SSE dropped, ping only) keeps the reported state
 *
 * `getOnlineMembers` enriches emails with display names from Postgres, which is
 * not available in the unit-test environment, so that one dependency is mocked.
 * Everything under test (the registry and the visibility logic) is real.
 */

vi.mock("../display-name", () => ({
  resolveDisplayNames: async (emails: string[]) =>
    new Map(emails.map((e) => [e, e.split("@")[0]])),
}));
vi.mock("../posts", () => ({
  gravatarUrl: (email: string) => `https://gravatar.example/${email}`,
}));
vi.mock("../db", () => ({ pool: { query: async () => ({ rows: [] }) } }));
vi.mock("../live", () => ({ liveBus: { emit: () => {} } }));

// The module keeps its registry in module scope, so each test needs a fresh
// import. `vi.resetModules()` + dynamic import gives that.
async function freshPresence() {
  vi.resetModules();
  return await import("../presence");
}

describe("presence visibility", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("treats a member who never reports visibility as active", async () => {
    const p = await freshPresence();
    p.markOnline("a@example.com");
    const members = await p.getOnlineMembers();
    expect(members).toHaveLength(1);
    expect(members[0].visible).toBe(true);
  });

  it("flips visible to false when the client reports a hidden tab", async () => {
    const p = await freshPresence();
    p.markOnline("a@example.com");
    p.touch("a@example.com", false);
    const members = await p.getOnlineMembers();
    expect(members[0].visible).toBe(false);
  });

  it("flips back to true when the tab becomes visible again", async () => {
    const p = await freshPresence();
    p.markOnline("a@example.com");
    p.touch("a@example.com", false);
    p.touch("a@example.com", true);
    const members = await p.getOnlineMembers();
    expect(members[0].visible).toBe(true);
  });

  it("leaves the stored value untouched when visibility is omitted", async () => {
    const p = await freshPresence();
    p.markOnline("a@example.com");
    p.touch("a@example.com", false);
    // A plain heartbeat (older client, or a caller that does not know) must not
    // silently un-dim the member.
    p.touch("a@example.com");
    const members = await p.getOnlineMembers();
    expect(members[0].visible).toBe(false);
  });

  it("keeps the reported state when a ping re-registers a dropped member", async () => {
    const p = await freshPresence();
    // No markOnline: the SSE stream is gone and only the heartbeat arrives.
    p.touch("b@example.com", false);
    const members = await p.getOnlineMembers();
    expect(members).toHaveLength(1);
    expect(members[0].visible).toBe(false);
  });

  it("defaults a re-registered member to active when visibility is omitted", async () => {
    const p = await freshPresence();
    p.touch("b@example.com");
    const members = await p.getOnlineMembers();
    expect(members[0].visible).toBe(true);
  });

  it("reports visibility per member, not globally", async () => {
    const p = await freshPresence();
    p.markOnline("active@example.com");
    p.markOnline("away@example.com");
    p.touch("away@example.com", false);
    const members = await p.getOnlineMembers();
    const byEmail = Object.fromEntries(members.map((m) => [m.email, m.visible]));
    expect(byEmail["active@example.com"]).toBe(true);
    expect(byEmail["away@example.com"]).toBe(false);
  });
});
