/**
 * 「いいね」は廃止（2026-10-22 オーナー決定・docs/timeline-spec.md §4.2）。
 * リアクションの ❤️ と二重になっていた古い like が、Web に戻ってこないことを固定する。
 * DB の post_likes 表と like_count（アプリ用 API の既存項目）は残す。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as posts from "../posts";

const root = path.join(__dirname, "..", "..", "..");
const page = fs.readFileSync(path.join(root, "src/app/page.tsx"), "utf8");

describe("いいね廃止", () => {
  it("POST /api/posts/[id]/like のルートが無い", () => {
    expect(fs.existsSync(path.join(root, "src/app/api/posts/[id]/like/route.ts"))).toBe(false);
  });
  it("posts.ts に toggleLike が無い", () => {
    expect("toggleLike" in posts).toBe(false);
  });
  it("Web: L キー・onLike・いいねの通知の文言が無い", () => {
    expect(page).not.toMatch(/kbdRef\.current\.like/);
    expect(page).not.toMatch(/\bonLike\b/);
    expect(page).not.toMatch(/\/like`/);
    expect(page).not.toContain("いいねしました");
  });
  it("アプリ用 API の like_count は残す（古いアプリが読む）", async () => {
    const { agentPostDto } = await import("../agent-post-dto");
    expect(agentPostDto({ id: 1, text: "x", createdAt: "2026-10-22T00:00:00Z", likeCount: 3 })).toHaveProperty("like_count", 3);
  });
});

describe("もう作られない通知・付けた人の表示（2026-10-22）", () => {
  it("いいね・お気に入りの古い通知は一覧にも未読数にも入れない（DB の行は消さない）", async () => {
    const { vi } = await import("vitest");
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("COUNT") ? [{ c: 0 }] : [], rowCount: 0 }));
    vi.resetModules();
    vi.doMock("../db", () => ({ pool: { query } }));
    vi.doMock("../display-name", () => ({ resolveDisplayNames: async () => new Map(), cleanDisplayName: (x: string) => x }));
    vi.doMock("../user", () => ({ emailToUserIds: async () => new Map() }));
    const n = await import("../notifications");
    await n.listNotifications("a@b.c");
    await n.countUnreadNotifications("a@b.c");
    for (const [sql, params] of query.mock.calls as unknown as [string, unknown[]][]) {
      expect(sql).toMatch(/type <> ALL\(\$2::text\[\]\)/);
      expect(sql).not.toMatch(/DELETE/);
      expect(params[1]).toEqual(["like", "favorite"]);
    }
    expect(query).toHaveBeenCalledTimes(2);
    vi.doUnmock("../db");
    vi.doUnmock("../display-name");
    vi.doUnmock("../user");
  });

  it("Web: リアクションを押した直後の「付けた人」にメールを入れない", () => {
    expect(page).not.toMatch(/reactors: \[auth\?\.email/);
    expect(page).toMatch(/toggleReactionOptimistic\(current, emoji, myReactorName\)/);
    expect(page).toMatch(/const myReactorName = displayName/);
  });
});
