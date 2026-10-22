/** Ghost の問い合わせは時間で打ち切る（QA 2026-10-22: 応答しない Ghost で 25 秒止まっていた）。 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { listMembers, findMemberByEmail, _setGhostTimeoutForTest, GHOST_FETCH_TIMEOUT_MS } from "../ghost";

// つながるが応答しない fetch（打ち切りの合図だけは聞く）。
function hangingFetch() {
  return vi.fn((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)))
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  _setGhostTimeoutForTest(null);
});

describe("Ghost の打ち切り", () => {
  it("既定は 4 秒", () => {
    expect(GHOST_FETCH_TIMEOUT_MS).toBe(4_000);
  });

  it("応答しない Ghost: listMembers・findMemberByEmail は上限で失敗する（待ち続けない）", async () => {
    process.env.GHOST_ADMIN_API_URL = "https://ghost.invalid";
    process.env.GHOST_ADMIN_API_KEY = "kid:" + "00".repeat(32);
    const f = hangingFetch();
    vi.stubGlobal("fetch", f);
    _setGhostTimeoutForTest(80);
    const t0 = performance.now();
    await expect(listMembers()).rejects.toBeTruthy();
    await expect(findMemberByEmail("someone@example.com")).rejects.toBeTruthy();
    expect(performance.now() - t0).toBeLessThan(1_000);
    for (const call of f.mock.calls) expect((call[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });
});
