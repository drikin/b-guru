/** 投稿の応答は Ghost の会員一覧（冷えていると約 1.5 秒）を待たない。
 *  @メンションの通知は応答のあとに送り、表示名でも Ghost 名でも宛先が決まる。 */
import { describe, it, expect, vi, beforeEach } from "vitest";

let releaseMembers: () => void = () => {};
const listMembers = vi.fn(
  () =>
    new Promise((resolve) => {
      releaseMembers = () =>
        resolve([
          { email: "matsuo@example.com", name: "松尾 公也", status: "paid" },
          { email: "takuto@example.com", name: "Takuto Account", status: "paid" },
          { email: "free@example.com", name: "Free", status: "free" },
        ]);
    })
);
vi.mock("@/lib/ghost", () => ({ listMembers: () => listMembers(), findMemberByEmail: async () => null }));
vi.mock("@/lib/display-name", async (orig) => ({
  ...(await orig<typeof import("@/lib/display-name")>()),
  resolveDisplayNames: async (emails: string[]) =>
    new Map(emails.filter((e) => e === "takuto@example.com").map((e) => [e, "たくと"])),
}));
vi.mock("@/lib/profile", () => ({ getProfile: async () => ({ name: "ドリキン" }) }));
vi.mock("@/lib/posts", () => ({ createPost: async (p: { text: string }) => ({ id: 77, text: p.text }) }));
const createNotification = vi.fn(async () => {});
vi.mock("@/lib/notifications", () => ({ createNotification: (n: unknown) => createNotification(n) }));
vi.mock("@/lib/db", () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));
vi.mock("@/lib/live", () => ({ emitLive: () => {} }));
vi.mock("@/lib/push", () => ({ sendWebPush: async () => {} }));
vi.mock("@/lib/clubs", () => ({ classifyPost: async () => null }));
vi.mock("@/lib/user", () => ({ ensureUserId: async () => "uid_me" }));

import { publishPost } from "../publish";

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  listMembers.mockClear();
  createNotification.mockClear();
});

describe("publishPost の速さとメンション通知", () => {
  it("会員一覧を待たずに投稿を返し、そのあと表示名・Ghost 名の両方でメンションを通知する", async () => {
    const r = await publishPost("me@example.com", { text: "@たくと @[松尾 公也] 見て" });
    expect(r.status).toBe(201); // listMembers はまだ終わっていない
    expect(createNotification).not.toHaveBeenCalled();
    releaseMembers();
    await flush();
    await flush();
    const to = createNotification.mock.calls.map((c) => (c[0] as { userEmail: string }).userEmail).sort();
    expect(to).toEqual(["matsuo@example.com", "takuto@example.com"]);
  });

  it("@ が無い投稿は会員一覧を取りに行かない", async () => {
    const r = await publishPost("me@example.com", { text: "ただの投稿 2" });
    expect(r.status).toBe(201);
    expect(listMembers).not.toHaveBeenCalled();
  });
});
