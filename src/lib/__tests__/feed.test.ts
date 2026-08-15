import { describe, it, expect } from "vitest";
import {
  FeedPost,
  appendReplyLocal,
  parentInFeed,
  replaceReplyInFeed,
  removeReplyTemp,
  groupFeed,
  mergeFreshFeed,
} from "../feed";

/** Minimal valid FeedPost factory. All fields populated so shape-parity tests
 *  fail loudly if a required field is dropped. lastActivityAt defaults to
 *  createdAt (as the server returns for a fresh post/reply). */
function makePost(id: number, over: Partial<FeedPost> = {}): FeedPost {
  const createdAt = over.createdAt ?? "2026-08-13T09:00:00.000Z";
  return {
    id,
    authorEmail: over.authorEmail ?? "u" + id + "@example.com",
    authorName: over.authorName ?? "User" + id,
    authorAvatar: null,
    parentId: over.parentId ?? null,
    replyCount: 0,
    replies: [],
    lastActivityAt: over.lastActivityAt ?? createdAt,
    pinnedAt: null,
    recentComments: undefined,
    text: over.text ?? "post " + id,
    images: [],
    urlPreview: null,
    likeCount: 0,
    likedByMe: false,
    createdAt,
    ...over,
  };
}

/** A reply-shaped post (parentId set). */
function makeReply(id: number, parentId: number, over: Partial<FeedPost> = {}): FeedPost {
  return makePost(id, { parentId, authorEmail: "rep" + id + "@x.com", ...over });
}

describe("FeedPost shape (server/createPost contract parity)", () => {
  it("has every field the frontend relies on (id, parentId, replyCount, replies, lastActivityAt, authorAvatar, pinnedAt)", () => {
    const p = makePost(1);
    for (const k of [
      "id",
      "authorEmail",
      "authorName",
      "authorAvatar",
      "parentId",
      "replyCount",
      "replies",
      "lastActivityAt",
      "pinnedAt",
      "text",
      "images",
      "urlPreview",
      "likeCount",
      "likedByMe",
      "createdAt",
    ] as const) {
      expect(k in p, `${k} should be present`).toBe(true);
    }
  });
});

describe("parentInFeed", () => {
  const feed = [makePost(1, { replies: [makeReply(11, 1)] }), makePost(2)];
  it("finds a root post", () => expect(parentInFeed(feed, 1)).toBe(true));
  it("finds a parent that is itself a reply (nested in a root)", () =>
    expect(parentInFeed(feed, 11)).toBe(true));
  it("returns false when the parent is not in the loaded feed", () =>
    expect(parentInFeed(feed, 999)).toBe(false));
});

describe("appendReplyLocal (optimistic insert)", () => {
  const base = [makePost(1), makePost(2)];

  it("comment (OPTION B): appends reply, increments count, but STAYS IN PLACE and keeps lastActivity (reorder deferred to refresh)", () => {
    const now = "2026-08-13T10:00:00.000Z";
    const out = appendReplyLocal(base, 1, makeReply(20, 1, { createdAt: now }), false);
    // OPTION B: comment no longer reorders — order stays [1, 2].
    expect(out.map((g) => g.id)).toEqual([1, 2]);
    expect(out[0].replies?.map((r) => r.id)).toEqual([20]);
    expect(out[0].replyCount).toBe(1);
    // lastActivity UNCHANGED (comment no longer bumps locally, same as whisper).
    expect(out[0].lastActivityAt).toBe(base[0].lastActivityAt);
    // Other group untouched.
    expect(out[1].id).toBe(2);
    expect(out[1].replyCount).toBe(0);
  });

  it("whisper: appends reply + increments count but STAYS IN PLACE and keeps lastActivity", () => {
    const now = "2026-08-13T10:00:00.000Z";
    const out = appendReplyLocal(base, 2, makeReply(21, 2, { createdAt: now }), true);
    // Whisper does NOT reorder: order stays [1, 2].
    expect(out.map((g) => g.id)).toEqual([1, 2]);
    expect(out[1].replies?.map((r) => r.id)).toEqual([21]);
    expect(out[1].replyCount).toBe(1);
    // lastActivity UNCHANGED (whisper doesn't bump).
    expect(out[1].lastActivityAt).toBe(base[1].lastActivityAt);
  });

  it("does NOT duplicate a reply whose id already exists", () => {
    const feed = [makePost(1)];
    const once = appendReplyLocal(feed, 1, makeReply(30, 1), false);
    const twice = appendReplyLocal(once, 1, makeReply(30, 1), false);
    expect(twice[0].replies?.map((r) => r.id)).toEqual([30]);
    expect(twice[0].replyCount).toBe(1);
  });

  it("returns the feed UNCHANGED (same reference behavior) when parent is absent — caller must refresh", () => {
    const feed = [makePost(1)];
    const out = appendReplyLocal(feed, 999, makeReply(31, 999, {}), false);
    expect(out).toEqual(feed);
    expect(out[0].replies ?? []).toHaveLength(0);
  });
});

describe("replaceReplyInFeed (optimistic temp → server real reply)", () => {
  it("swaps the temp id for the real id in the parent group", () => {
    const tempId = 1234567890123;
    const feedWithTemp = appendReplyLocal([makePost(1)], 1, makeReply(tempId, 1), false);
    const real = makeReply(500, 1, { text: "final" });
    const out = replaceReplyInFeed(feedWithTemp, 1, tempId, real, false);
    const ids = out[0].replies?.map((r) => r.id) ?? [];
    expect(ids).toEqual([500]); // temp gone, real present
    expect(ids).not.toContain(tempId);
    expect(out[0].replies?.[0].text).toBe("final");
  });

  it("dedupes a STALE server reply with the same real id (silentRefreshFeed race)", () => {
    const tempId = 900001;
    const realId = 600;
    // Feed where BOTH the temp optimistic reply AND a fresh server reply (realId)
    // are present (the race case). replaceReplyInFeed must keep exactly one.
    const alreadyReal = appendReplyLocal([makePost(1)], 1, makeReply(realId, 1), false);
    const withTemp = appendReplyLocal(alreadyReal, 1, makeReply(tempId, 1), false);
    const merged = replaceReplyInFeed(withTemp, 1, tempId, makeReply(realId, 1), false);
    const ids = merged[0].replies?.map((r) => r.id) ?? [];
    expect(ids).toEqual([realId]); // exactly one real reply, no temp, no dup
  });

  it("whisper: replaces temp but leaves lastActivity unchanged", () => {
    const tempId = 900002;
    const feedWithTemp = appendReplyLocal([makePost(1)], 1, makeReply(tempId, 1), true);
    const real = makeReply(700, 1);
    const out = replaceReplyInFeed(feedWithTemp, 1, tempId, real, true);
    expect(out[0].replies?.map((r) => r.id)).toEqual([700]);
    expect(out[0].lastActivityAt).toBe(feedWithTemp[0].lastActivityAt);
  });
});

describe("removeReplyTemp (rollback on failure)", () => {
  it("removes the temp reply and decrements the count", () => {
    const tempId = 800001;
    const feedWithTemp = appendReplyLocal([makePost(1)], 1, makeReply(tempId, 1), false);
    const out = removeReplyTemp(feedWithTemp, 1, tempId);
    expect(out[0].replies ?? []).toHaveLength(0);
    expect(out[0].replyCount).toBe(0);
  });

  it("never decrements replyCount below zero", () => {
    const feed = [makePost(1)];
    const out = removeReplyTemp(feed, 1, 812345);
    expect(out[0].replyCount).toBe(0);
  });
});

describe("groupFeed (timeline sort + group key)", () => {
  it("sorts groups by lastActivity descending (newest first)", () => {
    const groups = groupFeed([
      makePost(1, { lastActivityAt: "2026-08-13T09:00:00.000Z" }),
      makePost(2, { lastActivityAt: "2026-08-13T12:00:00.000Z" }),
      makePost(3, { lastActivityAt: "2026-08-13T07:00:00.000Z" }),
    ]);
    expect(groups.map((g) => g.posts[0].id)).toEqual([2, 1, 3]);
  });

  it("one group per root post, dateKey derived from the LAST activity (so a late reply keeps it on the right day)", () => {
    const groups = groupFeed([makePost(1)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].posts[0].id).toBe(1);
    expect(groups[0].lastActivity).toBe("2026-08-13T09:00:00.000Z");
    expect(groups[0].dateKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("drops posts with an invalid date (no crash)", () => {
    const groups = groupFeed([makePost(1, { lastActivityAt: "not-a-date", createdAt: "garbage" })]);
    expect(groups).toHaveLength(0);
  });
});

describe("full optimistic comment flow (temp → refresh race → real)", () => {
  it("comment on a visible group leaves exactly one authoritative reply (OPTION B: stays in place)", () => {
    let feed = [makePost(1), makePost(2)];
    const after = "2026-08-13T11:00:00.000Z";
    const tempId = 111222333;
    // user submits → optimistic temp insert (comment; no longer bumped to top)
    feed = appendReplyLocal(feed, 1, makeReply(tempId, 1, { createdAt: after }), false);
    expect(feed.map((g) => g.id)).toEqual([1, 2]); // stays in place
    // an SSE silentRefreshFeed races in and brings a server reply with the real id
    const realId = 900;
    feed = appendReplyLocal(feed, 1, makeReply(realId, 1, { createdAt: after }), false);
    // POST resolves → replace temp with real, deduping the stale server copy
    feed = replaceReplyInFeed(feed, 1, tempId, makeReply(realId, 1, { createdAt: after }), false);
    const ids = feed[0].replies?.map((r) => r.id) ?? [];
    expect(ids).toEqual([realId]);
    expect(feed[0].replyCount).toBe(1);
    // OPTION B: lastActivity stays at the post's original value (not bumped locally).
    expect(feed[0].lastActivityAt).toBe("2026-08-13T09:00:00.000Z");
  });
});


describe("mergeFreshFeed (silentRefresh server-page merge)", () => {
  it("keeps older pages / temp roots that the fresh page didn't return", () => {
    const prev = [
      makePost(1, { lastActivityAt: "2026-08-13T10:00:00.000Z" }),
      makePost(2, { lastActivityAt: "2026-08-13T08:00:00.000Z" }),
    ];
    const fresh = [makePost(1, { lastActivityAt: "2026-08-13T10:00:00.000Z" })];
    const merged = mergeFreshFeed(prev, fresh);
    expect(merged.map((p) => p.id).sort()).toEqual([1, 2]);
  });

  it("keeps the NEWER lastActivityAt so a stale refresh can't sink a just-commented group", () => {
    const commentTime = "2026-08-13T11:00:00.000Z";
    // prev: post 5 was just commented on → optimistically bumped to the top with
    // a (temp) reply and a bumped lastActivityAt.
    const tempId = 999888777;
    const prev = [
      {
        ...makePost(5, { lastActivityAt: commentTime }),
        replies: [makeReply(tempId, 5, { createdAt: commentTime })],
        replyCount: 1,
      },
      makePost(1, { lastActivityAt: "2026-08-13T10:00:00.000Z" }),
    ];
    // fresh: server page-1 AS OF BEFORE the comment committed — post 5 is still
    // present but with its OLD lastActivityAt and without the reply.
    const fresh = [
      makePost(1, { lastActivityAt: "2026-08-13T10:00:00.000Z" }),
      makePost(5, { lastActivityAt: "2026-08-13T09:00:00.000Z" }),
    ];
    const merged = mergeFreshFeed(prev, fresh);
    const p5 = merged.find((p) => p.id === 5)!;
    // The race must NOT clobber the bumped lastActivityAt…
    expect(p5.lastActivityAt).toBe(commentTime);
    // …nor drop the optimistic reply the server hasn't seen yet.
    expect((p5.replies ?? []).map((r) => r.id)).toEqual([tempId]);
    // And the timeline still floats the group to the top.
    expect(groupFeed(merged)[0].posts[0].id).toBe(5);
  });

  it("uses the server value when the server is fresher (normal refresh keeps server order)", () => {
    const serverTime = "2026-08-13T12:00:00.000Z";
    const prev = [
      makePost(1, { lastActivityAt: "2026-08-13T11:00:00.000Z" }),
      makePost(2, { lastActivityAt: "2026-08-13T10:00:00.000Z" }),
    ];
    const fresh = [
      makePost(1, { lastActivityAt: serverTime }),
      makePost(2, { lastActivityAt: "2026-08-13T10:00:00.000Z" }),
    ];
    const merged = mergeFreshFeed(prev, fresh);
    expect(merged.find((p) => p.id === 1)!.lastActivityAt).toBe(serverTime);
    expect(groupFeed(merged)[0].posts[0].id).toBe(1);
  });

  it("returns prev unchanged when both lists are empty", () => {
    expect(mergeFreshFeed([], [])).toEqual([]);
  });
});
