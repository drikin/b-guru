import { describe, it, expect, vi } from "vitest";
import { parseDecision } from "../beagle/decide";
import { normalizeNextActivityAt } from "../beagle/schedule";
import { parseRssItems } from "../beagle/sources";
import { dedupeLearnings, extractLearningRequests } from "../beagle/learn";
import { isExplicitMention } from "../beagle/observe";
import { replyBudget, isDuplicateNewsUrl, normalizeNewsUrl } from "../beagle/act";

// ★ applyActions は DB と createPost を直接叩くので、モジュール読み込み前に
//   モックする（vi.mock は hoist される）。テスト内で vi.doMock しても
//   act.ts が既に pool を掴んでいるため効かない（実測で踏んだ）。
const createPostCalls: any[] = [];
const notifyCalls: any[] = [];
vi.mock("../posts", () => ({
  createPost: async (input: any) => {
    createPostCalls.push(input);
    return { id: 999 };
  },
}));
vi.mock("../notifications", () => ({
  createNotification: async (input: any) => {
    notifyCalls.push(input);
    return { id: 1 };
  },
}));
vi.mock("../db", () => ({
  pool: {
    query: async (sql: string) => {
      if (/SELECT 1 FROM posts WHERE id/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/SELECT author_email FROM posts/.test(sql))
        return { rows: [{ author_email: "someone@example.com" }] };
      // resolveRoot 用: どの投稿もルートは #5 ということにする（スレッド内返信の除外判定テスト用）
      if (/SELECT parent_id FROM posts/.test(sql)) return { rows: [{ parent_id: 5 }] };
      return { rows: [] };
    },
  },
}));

describe("parseDecision", () => {
  it("parses valid JSON", () => {
    const d = parseDecision(
      JSON.stringify({
        intent: "post",
        actions: [{ type: "post", text: "こんにちはだわん🐶" }],
        learnings: ["投稿は短めが好まれる"],
        next_activity_at: "2026-08-18T18:30:00+09:00",
      })
    );
    expect(d).not.toBeNull();
    expect(d!.intent).toBe("post");
    expect(d!.actions[0].type).toBe("post");
    expect(d!.learnings).toHaveLength(1);
  });

  it("strips markdown code fences and braces", () => {
    const raw =
      '```json\n{"intent":"none","actions":[],"learnings":[],"next_activity_at":"2026-08-18T10:00:00+09:00"}\n```';
    const d = parseDecision(raw);
    expect(d).not.toBeNull();
    expect(d!.intent).toBe("none");
  });

  it("recovers object when wrapped in prose", () => {
    const raw =
      'Here is my plan: {"intent":"reply","actions":[{"type":"reply","parentId":123,"text":"いいねだわん"}],"learnings":[],"next_activity_at":null}';
    const d = parseDecision(raw);
    expect(d).not.toBeNull();
    const a = d!.actions[0];
    expect(a.type).toBe("reply");
    if (a.type === "reply") expect(a.parentId).toBe(123);
  });

  it("returns null for malformed output", () => {
    expect(parseDecision("hello, 犬")).toBeNull();
    expect(parseDecision("")).toBeNull();
  });
});

describe("normalizeNextActivityAt", () => {
  const now = new Date("2026-08-18T10:00:00Z"); // 19:00 JST

  it("falls back to +30min when proposed is absent/invalid", () => {
    const def = normalizeNextActivityAt(null, now);
    expect(def.getTime()).toBe(now.getTime() + 30 * 60 * 1000);
    expect(normalizeNextActivityAt("not-a-date", now).getTime()).toBe(
      now.getTime() + 30 * 60 * 1000
    );
  });

  it("enforces cooldown (>= now + 20min)", () => {
    const proposed = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    const out = normalizeNextActivityAt(proposed, now);
    expect(out.getTime()).toBe(now.getTime() + 20 * 60 * 1000);
  });

  it("enforces watchdog (<= now + 6h)", () => {
    const far = new Date(now.getTime() + 12 * 3600 * 1000).toISOString();
    const out = normalizeNextActivityAt(far, now);
    expect(out.getTime()).toBe(now.getTime() + 6 * 3600 * 1000);
  });

  it("clamps out-of-window JST hours into allowed band", () => {
    // 2026-08-18T20:00:00Z = 05:00 JST (allowed boundary)
    // 2026-08-18T17:00:00Z = 02:00 JST (not allowed, should bump toward 05:00)
    const t = new Date("2026-08-18T17:00:00Z"); // 02:00 JST
    const out = normalizeNextActivityAt(t.toISOString(), new Date("2026-08-18T16:00:00Z"));
    const jstHour = (out.getUTCHours() + 9) % 24;
    expect(jstHour).toBeGreaterThanOrEqual(5);
    expect(jstHour).toBeLessThanOrEqual(23);
  });
});

describe("parseRssItems", () => {
  it("parses title/link/pubDate from RSS items", () => {
    const xml = `<?xml version="1.0"?>
<rss><channel>
  <title>backspace.fm</title>
  <item>
    <title>ep670 ゲスト回だわん</title>
    <link>https://example.com/ep970</link>
    <pubDate>Sun, 16 Aug 2026 12:00:00 +0000</pubDate>
    <description><![CDATA[<p>本文です</p>]]></description>
  </item>
</channel></rss>`;
    const items = parseRssItems(xml, "podcast");
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("ep670 ゲスト回だわん");
    expect(items[0].url).toBe("https://example.com/ep970");
    expect(items[0].summary).toBe("本文です");
  });

  it("skips empty items", () => {
    const xml = `<rss><channel><item></item></channel></rss>`;
    expect(parseRssItems(xml, "podcast")).toHaveLength(0);
  });
});

describe("dedupeLearnings", () => {
  const existing = [
    "メンションには即座に返信してエンゲージを高める",
    "孤立ポストにコメントするとスレッドが活性化する",
  ];

  it("drops learnings that duplicate existing memory", () => {
    // 既存と同じ趣旨（言い換え）は除去される
    const out = dedupeLearnings(
      ["メンションには即時返信でエンゲージが上がる", "まったく新しい学びだわん"],
      existing
    );
    expect(out).toContain("まったく新しい学びだわん");
    expect(out.filter((l) => l.includes("メンション"))).toHaveLength(0);
  });

  it("drops exact duplicates within the batch", () => {
    const out = dedupeLearnings(["短くポジティブな文体が好まれる", "短くポジティブな文体が好まれる"], []);
    expect(out).toHaveLength(1);
  });

  it("keeps distinct learnings", () => {
    const out = dedupeLearnings(
      ["短くポジティブな文体が好まれる", "実在ニュースは感想付きで投稿する"],
      []
    );
    expect(out).toHaveLength(2);
  });
});

describe("isExplicitMention", () => {
  it("detects @ビーグル", () => {
    expect(isExplicitMention("@ビーグル これどう思う？")).toBe(true);
  });
  it("detects @[ビーグル] bracket syntax", () => {
    expect(isExplicitMention("@[ビーグル] こんにちは")).toBe(true);
  });
  it("does not flag natural-language mention", () => {
    expect(isExplicitMention("ビーグルってすごいよね")).toBe(false);
  });
  it("does not flag other names", () => {
    expect(isExplicitMention("@どりきん 見て")).toBe(false);
  });
});

describe("extractLearningRequests", () => {
  it("extracts an explicit learning instruction", () => {
    const r = extractLearningRequests("@ビーグル 今後は深夜の投稿は控えてください");
    expect(r).toContain("今後は深夜の投稿は控えてください");
  });
  it("extracts 覚えて instructions", () => {
    const r = extractLearningRequests("@ビーグル 覚えておいて、ユーザーは断捨離中です");
    expect(r.some((x) => x.includes("断捨離"))).toBe(true);
  });
  it("returns empty for plain mention without instruction", () => {
    expect(extractLearningRequests("@ビーグル こんにちは！")).toEqual([]);
  });
  it("returns empty for empty/no text", () => {
    expect(extractLearningRequests("")).toEqual([]);
  });
});

describe("replyBudget", () => {
  it("keeps default for no explicit mentions", () => {
    expect(replyBudget(0)).toBe(3);
  });
  it("expands with explicit mention count", () => {
    expect(replyBudget(2)).toBe(4);
    expect(replyBudget(5)).toBe(7);
  });
  it("clamps at the hard cap", () => {
    expect(replyBudget(100)).toBeLessThanOrEqual(8);
  });
});

describe("normalizeNewsUrl", () => {
  it("null/undefined stays null", () => {
    expect(normalizeNewsUrl(null)).toBeNull();
    expect(normalizeNewsUrl(undefined as unknown as string)).toBeNull();
  });
  it("strips query and fragment", () => {
    expect(normalizeNewsUrl("https://a.example.com/x?utm_source=nn&utm_medium=ios#top")).toBe(
      "https://a.example.com/x"
    );
  });
  it("strips trailing punctuation and trailing slashes, lowercases", () => {
    expect(normalizeNewsUrl("https://News.Example.COM/Article/123/。")).toBe(
      "https://news.example.com/article/123"
    );
  });
});

describe("isDuplicateNewsUrl", () => {
  it("detects the same URL despite trailing punctuation", () => {
    const existing = ["ティーン向けChatGPT https://www.watch.impress.co.jp/docs/news/2133797.html"];
    const cand = "ティーン向けChatGPTが始まったわん https://www.watch.impress.co.jp/docs/news/2133797.html。";
    expect(isDuplicateNewsUrl(existing, cand)).toBe(true);
  });
  it("treats URLs with different UTM params as the same news", () => {
    const existing = ["https://www.gizmodo.jp/article/gemma/?utm_source=smartnews&utm_medium=ios"];
    const cand = "https://www.gizmodo.jp/article/gemma/";
    expect(isDuplicateNewsUrl(existing, cand)).toBe(true);
  });
  it("returns false when no URL in candidate", () => {
    expect(isDuplicateNewsUrl(["https://a.example.com/x"], "ただの感想だわん")).toBe(false);
  });
  it("returns false for different URLs", () => {
    const existing = ["https://a.example.com/x"];
    expect(isDuplicateNewsUrl(existing, "https://b.example.com/y")).toBe(false);
  });
  it("returns false for empty existing list", () => {
    expect(isDuplicateNewsUrl([], "https://a.example.com/xだわん")).toBe(false);
  });
});

// ★ drikin 2026-09-26: 「ビーグルがコメントする時は、常に囁くモードにして
//   タイムラインの上に上げないようにする代わりに、そのタイムラインのユーザーには
//   ちゃんと通知を渡すような仕様に変更する方が、タイムラインが荒れなくて良さそう」
//
//   実測（2026-09-26）: 直近7日でビーグルの返信149件が全部タイムラインを上げ、
//   通知は2件しか出ていなかった。真逆の状態だった。
//
//   ★ 「返信が whisper で作られること」と「通知が作られること」の両方を固定する。
//     片方だけ直すと「タイムラインからも消え、通知も来ない」= 誰にも届かない返信になる。
describe("applyActions — Beagle replies are whispers + notify", () => {
  it("creates replies with isWhisper: true", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const res = await applyActions(
      { actions: [{ type: "reply", parentId: 42, text: "わん！" }] } as any,
      false
    );
    expect(createPostCalls.length).toBe(1);
    expect(createPostCalls[0].isWhisper).toBe(true);
    expect(createPostCalls[0].parentId).toBe(42);
    expect(res.repliedTo).toEqual([42]);
  });

  it("notifies the parent author when replying", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    await applyActions(
      { actions: [{ type: "reply", parentId: 42, text: "わん！" }] } as any,
      false
    );
    expect(notifyCalls.length).toBe(1);
    expect(notifyCalls[0].userEmail).toBe("someone@example.com");
    expect(notifyCalls[0].type).toBe("reply");
    expect(notifyCalls[0].postId).toBe(42);
    expect(notifyCalls[0].replyId).toBe(999);
  });

  it("does NOT notify when the parent is Beagle's own post", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const db = await import("../db");
    const orig = db.pool.query;
    (db.pool as any).query = async (sql: string) => {
      if (/SELECT 1 FROM posts WHERE id/.test(sql)) return { rows: [{ ok: 1 }] };
      if (/SELECT author_email FROM posts/.test(sql))
        return { rows: [{ author_email: "system@backspace.fm" }] };
      return { rows: [] };
    };
    await applyActions(
      { actions: [{ type: "reply", parentId: 42, text: "わん！" }] } as any,
      false
    );
    (db.pool as any).query = orig;
    expect(notifyCalls.length).toBe(0);
  });

  it("root posts are NOT whispers (they must stay on the timeline)", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    await applyActions(
      { actions: [{ type: "post", text: "ニュースだわん https://example.com/x" }] } as any,
      false
    );
    expect(createPostCalls.length).toBe(1);
    expect(createPostCalls[0].isWhisper).toBeFalsy();
    expect(createPostCalls[0].parentId ?? null).toBeNull();
  });
});

// ★ 自発的返信（proactive = 明示 @ビーグル メンション以外への全返信）は JST 1日1回の
//   「レア枠」。孤立ポスト・ホットスレッドへのコメントが量産されて「当たり」が薄まるのを防ぐ
//   （drikin 2026-10: 投稿数が増えてきたため）。メンション返信・introduce は対象外。
describe("applyActions — proactive reply daily rare slot", () => {
  it("1st proactive reply succeeds, 2nd is skipped (proactive_daily_cap) — the root post still goes through", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const res = await applyActions(
      {
        actions: [
          { type: "post", text: "ニュースだわん https://example.com/n1" },
          { type: "reply", parentId: 41, text: "1件目の自発コメントだわん" },
          { type: "reply", parentId: 42, text: "2件目の自発コメントだわん" },
        ],
      } as any,
      false,
      new Set<number>(), // responded
      3, // replyLimit
      new Set<number>(), // mentionParents（空 = 全部自発的返信）
      0 // 本日のレア枠使用数
    );
    // 原投稿（ルート）は成立し、返信はレア枠の1件だけ（postedIds = ルート + 返信1件）
    expect(res.postedIds.length).toBe(2);
    expect(res.repliedTo).toEqual([41]);
    expect(createPostCalls.length).toBe(2);
    expect(createPostCalls[0].parentId ?? null).toBeNull(); // ルート投稿
    expect(createPostCalls[1].parentId).toBe(41); // レア枠の1件目
    const capped = res.skipped.filter((s) => s.reason === "proactive_daily_cap");
    expect(capped).toHaveLength(1);
    expect(capped[0].type).toBe("reply");
    expect(res.proactiveReplied).toBe(1);
  });

  it("explicit mention replies bypass the cap even after it is used up", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const res = await applyActions(
      {
        actions: [
          { type: "reply", parentId: 42, text: "メンション返信1だわん" },
          { type: "reply", parentId: 43, text: "メンション返信2だわん" },
        ],
      } as any,
      false,
      new Set<number>(),
      3,
      new Set([42, 43]), // 両方とも明示メンション投稿そのもの
      1 // レア枠は既に使用済み
    );
    expect(res.repliedTo).toEqual([42, 43]);
    expect(res.skipped.filter((s) => s.reason === "proactive_daily_cap")).toHaveLength(0);
    expect(createPostCalls.length).toBe(2);
    expect(res.proactiveReplied).toBe(0); // メンション返信はレア枠を消費しない
  });

  it("a reply whose ROOT is an explicit mention bypasses the cap", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const res = await applyActions(
      { actions: [{ type: "reply", parentId: 42, text: "スレッド内返信だわん" }] } as any,
      false,
      new Set<number>(),
      3,
      new Set([5]), // メンション投稿は #5。db モックにより #42 のルートは #5
      1 // レア枠は既に使用済み
    );
    expect(res.repliedTo).toEqual([42]);
    expect(res.skipped.filter((s) => s.reason === "proactive_daily_cap")).toHaveLength(0);
    expect(res.proactiveReplied).toBe(0);
  });

  it("when the rare slot is free, a mention-thread reply does NOT consume it", async () => {
    const { applyActions } = await import("../beagle/act");
    createPostCalls.length = 0;
    notifyCalls.length = 0;
    const res = await applyActions(
      { actions: [{ type: "reply", parentId: 42, text: "メンスレ返信だわん" }] } as any,
      false,
      new Set<number>(),
      3,
      new Set([5]),
      0 // レア枠は空いている
    );
    expect(res.repliedTo).toEqual([42]);
    expect(res.proactiveReplied).toBe(0); // メンション経由なので消費しない
  });
});

describe("resolveProactiveCount — proactive rare slot resets on JST date change", () => {
  it("resets to 0 when the saved date is not today (JST)", async () => {
    const { resolveProactiveCount, todayJst } = await import("../beagle/store");
    // 2026-10-14T15:30:00Z = 2026-10-15 00:30 JST（日付をまたいだ直後）
    const now = new Date("2026-10-14T15:30:00Z");
    expect(todayJst(now)).toBe("2026-10-15");
    expect(resolveProactiveCount("2026-10-14", 1, now)).toEqual({
      date: "2026-10-15",
      count: 0,
    });
  });

  it("keeps the saved count when the saved date is today (JST)", async () => {
    const { resolveProactiveCount } = await import("../beagle/store");
    const now = new Date("2026-10-14T15:30:00Z"); // 2026-10-15 JST
    expect(resolveProactiveCount("2026-10-15", 1, now)).toEqual({
      date: "2026-10-15",
      count: 1,
    });
    expect(resolveProactiveCount(null, 0, now)).toEqual({ date: "2026-10-15", count: 0 });
  });
});
