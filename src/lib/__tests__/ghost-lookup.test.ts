/**
 * 会員の確認（lib/ghost.ts の findMemberByEmail）で本物の会員を誤って「会員でない」にしない（セキュリティの指摘 2026-10-22）。
 *  - 60 秒の会員一覧キャッシュに居ない人は、その人のメールで Ghost に直接確かめてから答える
 *  - 直接の答えが「居ない」なら null（＝会員でない）、届かなければ GhostUnavailableError
 *  - 会員一覧は最後のページまで辿る（以前は 2000 人で打ち切り）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const member = (email: string, status = "paid") => ({ email, name: email.split("@")[0], status });
type Page = { members: unknown[]; meta?: { pagination?: { next: number | null } } };

let ghost: typeof import("../ghost");
let fetchMock: ReturnType<typeof vi.fn>;
const urls = () => fetchMock.mock.calls.map((c) => decodeURIComponent(String(c[0])));

function respond(handler: (url: string) => Page | "hang" | number) {
  fetchMock = vi.fn(async (url: unknown, init?: { signal?: AbortSignal }) => {
    const r = handler(decodeURIComponent(String(url)));
    if (r === "hang") return new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
    if (typeof r === "number") return new Response("err", { status: r });
    return new Response(JSON.stringify(r), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(async () => {
  process.env.GHOST_ADMIN_API_URL = "https://ghost.invalid";
  process.env.GHOST_ADMIN_API_KEY = "kid:" + "00".repeat(32);
  vi.resetModules();
  ghost = await import("../ghost");
  ghost._setGhostTimeoutForTest(80);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findMemberByEmail", () => {
  it("★ 一覧のキャッシュに居ない会員も、直接確かめて会員として返す（失効させない）", async () => {
    respond((u) => (u.includes("filter=email:'late@x'") ? { members: [member("late@x")] } : { members: [member("a@x")], meta: { pagination: { next: null } } }));
    await ghost.listMembers(); // キャッシュには a@x だけ
    const m = await ghost.findMemberByEmail("Late@x");
    expect(m?.email).toBe("late@x");
    expect(ghost.isPaidMember(m!)).toBe(true);
    expect(urls().some((u) => u.includes("filter=email:'late@x'"))).toBe(true);
  });

  it("キャッシュに居る人は問い合わせずに答える", async () => {
    respond(() => ({ members: [member("a@x")], meta: { pagination: { next: null } } }));
    await ghost.listMembers();
    const n = fetchMock.mock.calls.length;
    expect((await ghost.findMemberByEmail("a@x"))?.email).toBe("a@x");
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it("直接の答えが「居ない」なら null（会員でない）", async () => {
    respond((u) => (u.includes("filter=") ? { members: [] } : { members: [member("a@x")], meta: { pagination: { next: null } } }));
    await ghost.listMembers();
    expect(await ghost.findMemberByEmail("nobody@x")).toBeNull();
  });

  it("直接の問い合わせが届かない（応答しない・5xx）なら GhostUnavailableError（unreachable）", async () => {
    respond((u) => (u.includes("filter=") ? "hang" : { members: [member("a@x")], meta: { pagination: { next: null } } }));
    await ghost.listMembers();
    await expect(ghost.findMemberByEmail("late@x")).rejects.toMatchObject({ name: "GhostUnavailableError", unreachable: true });
    respond(() => 503);
    await expect(ghost.findMemberByEmail("late2@x")).rejects.toMatchObject({ unreachable: true, status: 503 });
  });

  it("メールの ' は NQL で逃がす（別の条件を差し込めない）", async () => {
    respond(() => ({ members: [] }));
    await ghost.findMemberByEmail("o'brien@x");
    expect(urls()[0]).toContain("filter=email:'o\\'brien@x'");
  });
});

describe("listMembers", () => {
  it("最後のページまで辿る（2000 人を超えても打ち切らない）", async () => {
    const pages = 25;
    respond((u) => {
      const page = Number(/page=(\d+)/.exec(u)![1]);
      return {
        members: Array.from({ length: 100 }, (_, i) => member(`m${page}-${i}@x`)),
        meta: { pagination: { next: page < pages ? page + 1 : null } },
      };
    });
    const all = await ghost.listMembers();
    expect(all).toHaveLength(2500);
    expect(fetchMock).toHaveBeenCalledTimes(25);
    expect(ghost.MEMBER_LIST_MAX_PAGES).toBe(200);
  });
});
