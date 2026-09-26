import { describe, it, expect, vi, beforeEach } from "vitest";

// The DB is mocked: these tests pin the *validation and aggregation* rules,
// which is where the security-relevant decisions live (what may be stored as a
// reaction, and how custom references are resolved). Query correctness against
// real Postgres is covered by the E2E guard on production.
const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import {
  isValidReactionValue,
  isCustomEmojiRef,
  customEmojiName,
  toggleReaction,
  getReactions,
  createCustomEmoji,
} from "../reactions";

beforeEach(() => {
  query.mockReset();
});

describe("isValidReactionValue", () => {
  it("accepts a plain emoji", () => {
    expect(isValidReactionValue("❤️")).toBe(true);
    expect(isValidReactionValue("👍")).toBe(true);
    expect(isValidReactionValue("🎉")).toBe(true);
  });

  it("accepts a ZWJ sequence and skin-tone modifier", () => {
    // These are longer than one code point; a naive length check would reject
    // them and silently break common emoji.
    expect(isValidReactionValue("👨‍👩‍👧")).toBe(true);
    expect(isValidReactionValue("👍🏽")).toBe(true);
  });

  it("accepts a well-formed custom reference", () => {
    expect(isValidReactionValue(":drikin:")).toBe(true);
    expect(isValidReactionValue(":a_b_1:")).toBe(true);
  });

  it("rejects prose, which would otherwise blow up the chip layout", () => {
    expect(isValidReactionValue("これはリアクションではありません")).toBe(false);
    expect(isValidReactionValue("hello world")).toBe(false);
  });

  it("rejects an empty value", () => {
    expect(isValidReactionValue("")).toBe(false);
  });

  it("rejects a malformed custom reference", () => {
    expect(isValidReactionValue(":UPPER:")).toBe(false);
    expect(isValidReactionValue(":has space:")).toBe(false);
    expect(isValidReactionValue(":colon:inside:")).toBe(false);
    expect(isValidReactionValue(":")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isValidReactionValue(undefined as unknown as string)).toBe(false);
    expect(isValidReactionValue(42 as unknown as string)).toBe(false);
  });
});

describe("custom emoji references", () => {
  it("detects the :name: form", () => {
    expect(isCustomEmojiRef(":drikin:")).toBe(true);
    expect(isCustomEmojiRef("❤️")).toBe(false);
  });

  it("extracts a valid name", () => {
    expect(customEmojiName(":drikin:")).toBe("drikin");
  });

  it("returns null for an invalid name", () => {
    expect(customEmojiName(":UPPER:")).toBeNull();
    expect(customEmojiName("❤️")).toBeNull();
  });
});

describe("toggleReaction", () => {
  it("rejects an invalid emoji before touching the database", async () => {
    await expect(toggleReaction("post", 1, "a@b.c", "not an emoji")).rejects.toThrow(
      "invalid_emoji"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("rejects a custom reference that is not registered", async () => {
    query.mockResolvedValueOnce({ rows: [] }); // the custom_emojis lookup
    await expect(toggleReaction("post", 1, "a@b.c", ":ghost:")).rejects.toThrow(
      "unknown_emoji"
    );
  });

  it("inserts when the user has not reacted yet", async () => {
    query
      .mockResolvedValueOnce({ rows: [] }) // not already reacted
      .mockResolvedValueOnce({ rows: [] }) // insert
      .mockResolvedValueOnce({
        rows: [{ target_id: 1, emoji: "❤️", count: 1, mine: true, reactors: ["a@b.c"] }],
      }); // getReactions summary
    const r = await toggleReaction("post", 1, "a@b.c", "❤️");
    expect(r.added).toBe(true);
    expect(r.reactions).toHaveLength(1);
    expect(r.reactions[0].count).toBe(1);
  });

  it("deletes when the user already reacted (toggle off)", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // already reacted
      .mockResolvedValueOnce({ rows: [] }) // delete
      .mockResolvedValueOnce({ rows: [] }); // summary now empty
    const r = await toggleReaction("post", 1, "a@b.c", "❤️");
    expect(r.added).toBe(false);
    expect(r.reactions).toEqual([]);
  });

  it("verifies a registered custom emoji before storing it", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // custom exists
      .mockResolvedValueOnce({ rows: [] }) // not reacted
      .mockResolvedValueOnce({ rows: [] }) // insert
      .mockResolvedValueOnce({ rows: [] }); // summary
    await toggleReaction("post", 1, "a@b.c", ":drikin:");
    // The first query must be the custom_emojis existence check.
    expect(String(query.mock.calls[0][0])).toContain("custom_emojis");
  });
});

describe("getReactions", () => {
  it("returns an empty map without querying when there are no targets", async () => {
    const m = await getReactions("post", [], "a@b.c");
    expect(m.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("groups rows by target id", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { target_id: 1, emoji: "❤️", count: 3, mine: true, reactors: ["a@b.c"] },
        { target_id: 1, emoji: "🎉", count: 1, mine: false, reactors: ["x@y.z"] },
        { target_id: 2, emoji: "👍", count: 2, mine: false, reactors: ["x@y.z"] },
      ],
    });
    const m = await getReactions("post", [1, 2], "a@b.c");
    expect(m.get(1)).toHaveLength(2);
    expect(m.get(2)).toHaveLength(1);
    expect(m.get(1)![0].count).toBe(3);
    expect(m.get(1)![0].mine).toBe(true);
  });

  it("marks mine=false for an anonymous viewer", async () => {
    query.mockResolvedValueOnce({
      rows: [{ target_id: 1, emoji: "❤️", count: 1, mine: false, reactors: ["a@b.c"] }],
    });
    const m = await getReactions("post", [1], null);
    expect(m.get(1)![0].mine).toBe(false);
  });

  // The tooltip shows reactor names to other members (drikin 2026-09-25), so the
  // query must resolve emails to display names. If someone reverts this to a
  // plain ARRAY_AGG(user_email), every tooltip silently leaks email addresses —
  // a privacy regression that no visual check would catch.
  it("resolves reactors to display names, not emails", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getReactions("post", [1], "a@b.c");
    const sql = query.mock.calls[query.mock.calls.length - 1][0] as string;
    expect(sql).toContain("user_profiles");
    expect(sql).toContain("display_name");
    expect(sql).toContain("split_part");
    // The raw email must never be aggregated straight into the tooltip list.
    expect(sql).not.toMatch(/ARRAY_AGG\(\s*user_email/);
  });

  it("passes the reactor list through to the summary", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { target_id: 1, emoji: "❤️", count: 2, mine: false, reactors: ["どりきん", "eiko"] },
      ],
    });
    const m = await getReactions("post", [1], null);
    expect(m.get(1)![0].reactors).toEqual(["どりきん", "eiko"]);
  });

  it("batches every target into one query", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getReactions("post", [1, 2, 3, 4, 5], "a@b.c");
    expect(query).toHaveBeenCalledTimes(1);
  });

  // ★ おもち 2026-09-26: 「アイコンでは「14」と表示されているのにマウスオーバー
  //   すると「12人」と表示される」。原因は `reactors` が REACTOR_LIMIT=12 で
  //   切られているのに、ツールチップが `reactors.length` を人数として出していた
  //   こと。**count は実数、reactors は上限つき**という関係を固定する。
  it("caps the reactor list but keeps the true count", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await getReactions("post", [1], null);
    const sql = query.mock.calls[query.mock.calls.length - 1][0] as string;
    // リストは上限で切る
    expect(sql).toMatch(/\)\)\[1:\d+\] AS reactors/);
    // 件数は COUNT(*) の実数（切らない）
    expect(sql).toContain("COUNT(*)::int AS count");
  });

  it("keeps count larger than the truncated reactor list", async () => {
    // 14人がリアクション、名前リストは12件まで（実測されたバグの形）
    const reactors = Array.from({ length: 12 }, (_, i) => `user${i}`);
    query.mockResolvedValueOnce({
      rows: [{ target_id: 1, emoji: "🎉", count: 14, mine: false, reactors }],
    });
    const m = await getReactions("post", [1], null);
    const r = m.get(1)![0];
    // ツールチップは count を使うので 14 と出る。reactors.length は 12。
    expect(r.count).toBe(14);
    expect(r.reactors.length).toBe(12);
    expect(r.count).toBeGreaterThan(r.reactors.length);
  });
});

describe("createCustomEmoji", () => {
  it("normalises the name to lowercase", async () => {
    query.mockResolvedValueOnce({
      rows: [
        { id: 1, name: "drikin", image_url: "/api/media/x.png", created_by: "a@b.c", created_at: "now" },
      ],
    });
    const e = await createCustomEmoji("Drikin", "/api/media/x.png", "a@b.c");
    expect(e.name).toBe("drikin");
    expect(query.mock.calls[0][1][0]).toBe("drikin");
  });

  it("rejects an invalid name before querying", async () => {
    await expect(createCustomEmoji("bad name!", "/x.png", "a@b.c")).rejects.toThrow(
      "invalid_name"
    );
    expect(query).not.toHaveBeenCalled();
  });

  it("maps a unique violation to name_taken", async () => {
    query.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(createCustomEmoji("drikin", "/x.png", "a@b.c")).rejects.toThrow(
      "name_taken"
    );
  });
});
