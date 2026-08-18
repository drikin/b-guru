import { describe, it, expect } from "vitest";
import { parseDecision } from "../beagle/decide";
import { normalizeNextActivityAt } from "../beagle/schedule";
import { parseRssItems } from "../beagle/sources";
import { dedupeLearnings } from "../beagle/learn";

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
