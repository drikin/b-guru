/**
 * @メンションの候補（lib/members.ts）と Ghost（QA 2026-10-22）。
 *  - Ghost に届かない・鍵が無い: 500 にせず空か古い一覧
 *  - Ghost が「つながるが応答しない」: 古い一覧があれば即返し、取り直しは裏で 1 本だけ。失敗は 30 秒覚える
 *  - タイムラインの include=display は Ghost を待たない
 *  - Ghost の問い合わせは時間で打ち切る（AbortSignal.timeout）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const listMembers = vi.fn();
vi.mock("../ghost", () => ({ listMembers: (...a: unknown[]) => listMembers(...a) }));
vi.mock("../display-name", () => ({ resolveDisplayNames: async () => new Map(), cleanDisplayName: (n: string) => n }));
vi.mock("../user", () => ({ ensureUserId: async (e: string) => `uid_${e.split("@")[0]}` }));
vi.mock("../posts", () => ({ gravatarUrl: () => "/api/avatar/x" }));

const member = (name: string) => ({ email: `${name}@x`, name, status: "paid", avatar_image: null });
const never = () => new Promise<never>(() => {});

let mod: typeof import("../members");
beforeEach(async () => {
  vi.resetModules();
  listMembers.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mod = await import("../members");
  mod._resetMentionMembersForTest();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("mentionMembers", () => {
  it("初回に失敗したら空の一覧（投げない）・30 秒は取り直さない・過ぎたらまた取りに行く", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    listMembers.mockRejectedValueOnce(new TypeError("Cannot read properties of undefined (reading 'split')"));
    expect(await mod.mentionMembers()).toEqual([]);
    expect(await mod.mentionMembers()).toEqual([]);
    expect(listMembers).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + mod.MENTION_FAIL_BACKOFF_MS + 1);
    listMembers.mockResolvedValueOnce([member("あ")]);
    expect((await mod.mentionMembers()).map((m) => m.name)).toContain("あ");
    expect(listMembers).toHaveBeenCalledTimes(2);
  });

  it("★ 古い一覧があれば Ghost が応答しなくても即返す・裏の取り直しは 1 本だけ", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    listMembers.mockResolvedValueOnce([member("あ")]);
    const first = await mod.mentionMembers();
    vi.setSystemTime(Date.now() + 61_000);
    listMembers.mockImplementation(never); // つながるが応答しない
    const t0 = performance.now();
    const results = await Promise.all(Array.from({ length: 5 }, () => mod.mentionMembers()));
    expect(performance.now() - t0).toBeLessThan(100);
    for (const r of results) expect(r).toEqual(first);
    expect(listMembers).toHaveBeenCalledTimes(2); // 最初の 1 回 + 裏の取り直し 1 本
  });

  it("★ wait=false（タイムラインの display）は一覧が無くても Ghost を待たずに空を返す", async () => {
    listMembers.mockImplementation(never);
    const t0 = performance.now();
    expect(await mod.mentionMembers({ wait: false })).toEqual([]);
    expect(await mod.mentionMembers({ wait: false })).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
    expect(listMembers).toHaveBeenCalledTimes(1); // 裏で 1 本だけ
  });

  it("GET /api/members は Ghost の失敗でも 200（空の一覧）", async () => {
    vi.doMock("@/lib/session", () => ({ getSessionEmail: async () => "me@x" }));
    listMembers.mockRejectedValueOnce(new Error("ghost down"));
    const { GET } = await import("@/app/api/members/route");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ members: [] });
  });
});
