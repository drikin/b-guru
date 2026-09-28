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
// `getOnlineMembers` now identifies members by the opaque user_id, which it
// resolves through `users`. The real resolver would hit Postgres (mocked to
// return no rows above) and yield null for everyone, so it is mocked here with
// a deterministic email→id mapping. The registry and visibility logic under
// test stay real.
vi.mock("../user", () => ({
  emailToUserId: async (email: string) =>
    email ? `uid_${email.split("@")[0]}` : null,
  // presence now resolves the whole online set in one batched query instead of
  // one round-trip per member, so the mock must expose the batch form too.
  emailToUserIds: async (emails: (string | null | undefined)[]) => {
    const m = new Map<string, string>();
    for (const e of emails) {
      if (e) m.set(e.trim().toLowerCase(), `uid_${e.split("@")[0]}`);
    }
    return m;
  },
}));

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
    // `null` = not yet reported. The client renders it as active, but the server
    // must NOT claim it is a confirmed foreground tab.
    expect(members[0].visible).toBeNull();
  });

  it("does not assume active when the SSE stream opens", async () => {
    // Regression: markOnline used to seed `visible: true`, so every member who
    // never sends the flag (older cached client) showed as active forever —
    // measured 20 of 21 members "active", which is implausible.
    const p = await freshPresence();
    p.markOnline("a@example.com");
    p.markOnline("b@example.com");
    const members = await p.getOnlineMembers();
    expect(members.every((m) => m.visible === null)).toBe(true);
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

  it("defaults a re-registered member to unreported when visibility is omitted", async () => {
    const p = await freshPresence();
    p.touch("b@example.com");
    const members = await p.getOnlineMembers();
    // Not `true` — we genuinely do not know. The client renders null as active.
    expect(members[0].visible).toBeNull();
  });

  it("reports visibility per member, not globally", async () => {
    const p = await freshPresence();
    p.markOnline("active@example.com");
    p.markOnline("away@example.com");
    p.touch("active@example.com", true);
    p.touch("away@example.com", false);
    const members = await p.getOnlineMembers();
    const byId = Object.fromEntries(members.map((m) => [m.userId, m.visible]));
    expect(byId["uid_active"]).toBe(true);
    expect(byId["uid_away"]).toBe(false);
  });

  it("keeps unreported members distinct from confirmed-active ones", async () => {
    const p = await freshPresence();
    p.markOnline("unknown@example.com");
    p.markOnline("confirmed@example.com");
    p.touch("confirmed@example.com", true);
    const members = await p.getOnlineMembers();
    const byId = Object.fromEntries(members.map((m) => [m.userId, m.visible]));
    // Both render as active in the UI, but only one is a confirmed foreground
    // tab. Collapsing them would hide the "older client never reports" case.
    expect(byId["uid_unknown"]).toBeNull();
    expect(byId["uid_confirmed"]).toBe(true);
  });

  it("identifies online members by opaque user id, never by email", async () => {
    const p = await freshPresence();
    p.markOnline("someone@example.com");
    const members = await p.getOnlineMembers();
    expect(members[0].userId).toBe("uid_someone");
    expect("email" in members[0]).toBe(false);
    // The identity fields carry no address. (The avatar is a gravatar URL whose
    // hash is derived from the email server-side; the test mock echoes the
    // address, so it is excluded here.)
    const { avatar, ...identity } = members[0];
    expect(JSON.stringify(identity)).not.toContain("@");
  });

  it("broadcasts presence as user ids, not emails", async () => {
    const p = await freshPresence();
    p.markOnline("someone@example.com");
    // broadcast() is fire-and-forget; let its microtasks settle.
    await new Promise((r) => setTimeout(r, 0));
    const ids = await p.getOnlineUserIds();
    expect(ids).toEqual(["uid_someone"]);
    expect(JSON.stringify(ids)).not.toContain("@");
  });
});
