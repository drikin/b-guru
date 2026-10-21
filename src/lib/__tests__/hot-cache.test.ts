/** Hot topics: the ranking is shared by everyone (one SQL per HOT_TTL_MS or per new
 *  post), the per-viewer fields are still read per request for just those posts. */
import { describe, it, expect, vi } from "vitest";

const calls = vi.hoisted(() => ({ rank: 0, detail: [] as unknown[][] }));
vi.mock("../db", () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes("LIMIT $1") && sql.includes("ORDER BY 2 DESC")) {
        calls.rank++;
        return { rows: [{ id: 30, n: 9 }, { id: 10, n: 4 }, { id: 20, n: 4 }] };
      }
      if (sql.includes("p.id = ANY($2::int[])")) {
        calls.detail.push(params);
        // Returned in a different order, and post 20 was deleted meanwhile.
        return {
          rows: [10, 30].map((id) => ({
            id, author_id: "u", is_author: params[0] === "me@example.com" && id === 10, author_name: "n", parent_id: null,
            text: `post ${id}`, url_preview: null, created_at: new Date(), via: null, last_activity: new Date(),
            pinned_at: null, images: [], video_url: null, audio_url: null, club: null, club_manual: false,
            like_count: 0, liked_by_me: false, favorited_by_me: false, bookmarked_by_me: false, reply_count: 3, poll_json: null,
          })),
        };
      }
      return { rows: [] };
    }),
  },
}));

import { listHotTopics } from "../posts";
import { liveBus } from "../live";

describe("listHotTopics", () => {
  it("ranks once for everyone, keeps the order, drops deleted posts, keeps per-viewer fields", async () => {
    const mine = await listHotTopics("me@example.com", 5);
    const theirs = await listHotTopics("other@example.com", 5);
    expect(calls.rank).toBe(1);
    expect(calls.detail).toHaveLength(2);
    expect(calls.detail[0]).toEqual(["me@example.com", [30, 10, 20]]);
    expect(mine.map((p) => [p.id, p.recentComments])).toEqual([[30, 9], [10, 4]]);
    expect(mine.find((p) => p.id === 10)!.isAuthor).toBe(true);
    expect(theirs.find((p) => p.id === 10)!.isAuthor).toBe(false);

    // A new post re-ranks on the next request.
    liveBus.emit("change", { type: "post", postId: 99, action: "create" });
    await listHotTopics("me@example.com", 5);
    expect(calls.rank).toBe(2);

    // limit is respected
    expect((await listHotTopics("me@example.com", 1)).map((p) => p.id)).toEqual([30]);
  });
});
