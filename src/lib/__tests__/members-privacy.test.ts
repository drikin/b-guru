/**
 * /api/members and PATCH /api/clubs/leaders must not move member emails across
 * the API boundary.
 *
 * /api/members is served to EVERY logged-in member (it feeds @mention and the
 * club-leader picker). It used to include `email` for every paid member — a
 * full membership address dump. These tests call the REAL route handlers with
 * only their I/O dependencies mocked, so re-adding an email field fails here.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sessionEmail = vi.fn();
vi.mock("@/lib/session", () => ({ getSessionEmail: () => sessionEmail() }));

vi.mock("@/lib/ghost", () => ({
  listMembers: async () => [
    { email: "matsuo@gmail.com", name: "松尾 公也", status: "paid", avatar_image: null },
    { email: "noname@example.com", name: null, status: "comped", avatar_image: null },
    { email: "free@example.com", name: "Free", status: "free", avatar_image: null },
  ],
}));

const idOf = (e: string) => `uid_${e.split("@")[0]}`;
const userIdToEmail = vi.fn();
vi.mock("@/lib/user", () => ({
  ensureUserId: async (e: string) => idOf(e),
  userIdToEmail: (id: string) => userIdToEmail(id),
}));

const setClubLeader = vi.fn();
vi.mock("@/lib/club-leaders", () => ({
  getClubLeaders: async () => ({}),
  setClubLeader: (club: string, email: string | null) => setClubLeader(club, email),
}));
vi.mock("@/lib/admin", () => ({ isAdmin: (e: string) => e === "drikin@gmail.com" }));
vi.mock("@/lib/club-catalog", () => ({ CLUB_KEYS: new Set(["motorsport"]) }));

import { GET as membersGET } from "../../app/api/members/route";
import { PATCH as leadersPATCH } from "../../app/api/clubs/leaders/route";

function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

const patch = (body: unknown) =>
  leadersPATCH(
    new Request("http://x/api/clubs/leaders", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

beforeEach(() => {
  sessionEmail.mockReset();
  userIdToEmail.mockReset();
  setClubLeader.mockReset();
});

describe("GET /api/members — real handler", () => {
  it("returns members with no email anywhere in the payload", async () => {
    sessionEmail.mockResolvedValue("someone@example.com");
    const res = await membersGET();
    const json = await res.json();
    expect(json.members.length).toBeGreaterThan(0);
    expect(JSON.stringify(json)).not.toContain("@");
    expect(allKeys(json).has("email")).toBe(false);
  });

  it("identifies members by opaque userId and keeps paid/comped only", async () => {
    sessionEmail.mockResolvedValue("someone@example.com");
    const json = await (await membersGET()).json();
    const ids = json.members.map((m: { userId: string }) => m.userId);
    expect(ids).toContain("uid_matsuo");
    expect(ids).toContain("uid_noname");
    expect(ids).not.toContain("uid_free");
  });

  it("is 401 without a session", async () => {
    sessionEmail.mockResolvedValue(null);
    expect((await membersGET()).status).toBe(401);
  });
});

describe("PATCH /api/clubs/leaders — takes userId, resolves email server-side", () => {
  it("resolves the userId to the internal email and stores that", async () => {
    sessionEmail.mockResolvedValue("drikin@gmail.com");
    userIdToEmail.mockResolvedValue("matsuo@gmail.com");
    setClubLeader.mockResolvedValue({ club: "motorsport", userId: "uid_matsuo", name: "松尾" });
    const res = await patch({ club: "motorsport", userId: "uid_matsuo" });
    expect(res.status).toBe(200);
    expect(userIdToEmail).toHaveBeenCalledWith("uid_matsuo");
    expect(setClubLeader).toHaveBeenCalledWith("motorsport", "matsuo@gmail.com");
    expect(JSON.stringify(await res.json())).not.toContain("@");
  });

  it("rejects an unknown userId (cannot appoint an arbitrary address)", async () => {
    sessionEmail.mockResolvedValue("drikin@gmail.com");
    userIdToEmail.mockResolvedValue(null);
    const res = await patch({ club: "motorsport", userId: "nope" });
    expect(res.status).toBe(400);
    expect(setClubLeader).not.toHaveBeenCalled();
  });

  it("rejects the old { club, email } contract instead of silently removing the leader", async () => {
    // A stale admin tab still running old JS sends { club, email }. Treating the
    // missing userId as "remove" would clear the current leader with a 200.
    sessionEmail.mockResolvedValue("drikin@gmail.com");
    const res = await patch({ club: "motorsport", email: "attacker@example.com" });
    expect(res.status).toBe(400);
    expect(setClubLeader).not.toHaveBeenCalled();
  });

  it("never treats an address smuggled into userId as an email", async () => {
    // The only path from the body to an email must be the users-table lookup.
    sessionEmail.mockResolvedValue("drikin@gmail.com");
    userIdToEmail.mockResolvedValue(null); // no user has that id
    const res = await patch({ club: "motorsport", userId: "attacker@example.com" });
    expect(res.status).toBe(400);
    expect(setClubLeader).not.toHaveBeenCalled();
  });

  it("userId: null removes the leader", async () => {
    sessionEmail.mockResolvedValue("drikin@gmail.com");
    setClubLeader.mockResolvedValue(null);
    const res = await patch({ club: "motorsport", userId: null });
    expect(res.status).toBe(200);
    expect(setClubLeader).toHaveBeenCalledWith("motorsport", null);
  });

  it("is 403 for non-admins", async () => {
    sessionEmail.mockResolvedValue("someone@example.com");
    expect((await patch({ club: "motorsport", userId: "uid_matsuo" })).status).toBe(403);
    expect(setClubLeader).not.toHaveBeenCalled();
  });
});
