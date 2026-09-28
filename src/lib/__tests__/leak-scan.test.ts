/**
 * Unit test for the production E2E leak guard's scanner (scripts/leak-scan.mjs).
 * Synthetic fixtures only — no production data. The guard must flag every way
 * the server could re-leak an address, and must NOT flag an address a member
 * typed into their own post (otherwise every deploy would fail on such a post).
 */
import { describe, it, expect } from "vitest";
import { findEmailLeaks } from "../../../scripts/leak-scan.mjs";

describe("findEmailLeaks — must catch server-side leaks", () => {
  it("flags an email key even when its value looks harmless", () => {
    expect(findEmailLeaks({ members: [{ userId: "a", email: "x" }] })).toEqual([
      ".members[0].email (key)",
    ]);
  });

  it.each(["authorEmail", "userEmail", "actorEmail", "viewerEmail", "emails"])(
    "flags the %s key",
    (k) => {
      expect(findEmailLeaks({ x: { [k]: null } }).length).toBeGreaterThan(0);
    }
  );

  it("flags an address in a server field such as a name fallback", () => {
    // e.g. `name: cleanDisplayName(m.name) || m.email` regressing
    const hits = findEmailLeaks({ members: [{ userId: "a", name: "matsuo@gmail.com" }] });
    expect(hits).toEqual([".members[0].name"]);
  });

  it("flags an address nested deep, e.g. in presence userIds", () => {
    expect(findEmailLeaks({ type: "presence", userIds: ["ok", "who@example.com"] })).toEqual([
      ".userIds[1]",
    ]);
  });

  it("flags a leak next to user content in the same object", () => {
    const hits = findEmailLeaks({
      posts: [{ text: "mail me a@b.co", authorEmail: "c@d.co" }],
    });
    // Both the key and its address value are reported; the user's own text is not.
    expect(hits).toContain(".posts[0].authorEmail (key)");
    expect(hits.some((h: string) => h.includes(".text"))).toBe(false);
  });
});

describe("findEmailLeaks — must not flag clean or user-authored data", () => {
  it("passes the current clean /api/members shape", () => {
    expect(
      findEmailLeaks({ members: [{ userId: "fbea65618cb8", name: "松尾 公也", avatar: "/api/avatar/cbce" }] })
    ).toEqual([]);
  });

  it("ignores an address a member typed into their own post / chat / article", () => {
    expect(
      findEmailLeaks({
        posts: [{ authorId: "a", text: "連絡は foo@example.com まで", urlPreview: { url: "mailto:x@y.jp" } }],
        messages: [{ authorId: "b", body: "bar@example.com" }],
        articles: [{ authorId: "c", title: "t@u.jp", bodyMd: "q@r.jp", bodyHtml: "<a>q@r.jp</a>" }],
        comments: [{ authorId: "d", comment: "z@z.io" }],
      })
    ).toEqual([]);
  });

  it("does not treat an @mention or a handle without a domain as an address", () => {
    expect(findEmailLeaks({ posts: [{ authorName: "@ドリキン", authorId: "x" }] })).toEqual([]);
  });

  it("does not flag the gravatar-proxy avatar path", () => {
    expect(findEmailLeaks({ avatar: "/api/avatar/d88553116c58cf161f670f800c8c7a0f" })).toEqual([]);
  });
});
