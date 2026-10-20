import { describe, it, expect } from "vitest";
import { appendQuote, postPermalink, quoteExcerpt, quoteText, splitPostLinks } from "@/lib/chat-quote";

const LINK = "https://bsm.backspace.fm/#/post/123";

describe("postPermalink", () => {
  it("uses the canonical origin and #/post/<id>", () => {
    expect(postPermalink(123)).toBe(LINK);
    expect(postPermalink(5, "http://localhost:3000/")).toBe("http://localhost:3000/#/post/5");
  });
});

describe("quoteText", () => {
  it("builds the quote block with the first non-empty line", () => {
    expect(
      quoteText({ authorName: "ドリキン", text: "\n\n  今日の  散財\tです \n二行目", hasImages: false, permalink: LINK })
    ).toBe(`📝 ドリキン さんの投稿「今日の 散財 です」\n${LINK}\n`);
  });

  it("cuts at 40 code points and adds …", () => {
    const text = "あ".repeat(45);
    expect(quoteExcerpt(text, false)).toBe("あ".repeat(40) + "…");
    expect(quoteExcerpt("あ".repeat(40), false)).toBe("あ".repeat(40));
  });

  it("never splits an emoji / surrogate pair", () => {
    const text = "🍣".repeat(50);
    const ex = quoteExcerpt(text, false);
    expect(ex).toBe("🍣".repeat(40) + "…");
    expect(Array.from(ex.slice(0, -1)).every((c) => c === "🍣")).toBe(true);
    // 39 chars + emoji straddling the boundary in UTF-16 units
    const mixed = "a".repeat(39) + "😀" + "b";
    expect(quoteExcerpt(mixed, false)).toBe("a".repeat(39) + "😀" + "…");
  });

  it("uses 写真 for an image-only post", () => {
    expect(quoteText({ authorName: "A", text: "  \n ", hasImages: true, permalink: LINK })).toBe(
      `📝 A さんの投稿「写真」\n${LINK}\n`
    );
  });

  it("omits the excerpt when there is nothing", () => {
    expect(quoteText({ authorName: "A", text: "", hasImages: false, permalink: LINK })).toBe(`📝 A さんの投稿\n${LINK}\n`);
  });

  it("replaces @ with full-width ＠ so the quote does not mention anyone", () => {
    expect(
      quoteText({ authorName: "B", text: "長崎らしいものを食す旅に出た @住吉商店街", hasImages: false, permalink: LINK })
    ).toBe(`📝 B さんの投稿「長崎らしいものを食す旅に出た ＠住吉商店街」\n${LINK}\n`);
    expect(quoteExcerpt("@[柳家 三之助] こんにちは", false)).toBe("＠[柳家 三之助] こんにちは");
    expect(quoteExcerpt("x@y", false)).not.toContain("@");
  });

  it("strips Markdown marks", () => {
    expect(quoteExcerpt("## 🐾 ビーグル更新情報（10/14〜10/19）\n本文", false)).toBe("🐾 ビーグル更新情報（10/14〜10/19）");
    expect(quoteExcerpt("- **太字** と `code`", false)).toBe("太字 と code");
    expect(quoteExcerpt("> 引用 ~~消し~~ __下線__", false)).toBe("引用 消し 下線");
    expect(quoteExcerpt("###### 見出し6", false)).toBe("見出し6");
    expect(quoteExcerpt("1. 一番", false)).toBe("一番");
    expect(quoteExcerpt("* 星 + 足す", false)).toBe("星 + 足す");
    expect(quoteExcerpt("#タグ", false)).toBe("#タグ");
    expect(quoteExcerpt("- @someone **さん**", false)).toBe("＠someone さん");
    // a line that is only marks is skipped
    expect(quoteExcerpt("**\n次の行", false)).toBe("次の行");
  });

  it("falls back when the author name is empty", () => {
    expect(quoteText({ authorName: null, text: "hi", hasImages: false, permalink: LINK })).toBe(
      `📝 だれか さんの投稿「hi」\n${LINK}\n`
    );
  });
});

describe("appendQuote", () => {
  const q = `📝 A さんの投稿\n${LINK}\n`;
  it("keeps the existing draft, adding a new line", () => {
    expect(appendQuote("", q)).toBe(q);
    expect(appendQuote("   ", q)).toBe(q);
    expect(appendQuote("これ見て", q)).toBe(`これ見て\n${q}`);
    expect(appendQuote("これ見て\n", q)).toBe(`これ見て\n${q}`);
  });
});

describe("splitPostLinks", () => {
  it("finds B-guru post permalinks", () => {
    expect(splitPostLinks(`見て ${LINK} です`)).toEqual([
      { kind: "text", text: "見て " },
      { kind: "post", text: LINK, postId: 123 },
      { kind: "text", text: " です" },
    ]);
    expect(splitPostLinks("https://bsm.backspace.fm#/post/7")).toEqual([
      { kind: "post", text: "https://bsm.backspace.fm#/post/7", postId: 7 },
    ]);
  });

  it("ignores other sites and malformed ids", () => {
    expect(splitPostLinks("https://evil.example/#/post/1")).toEqual([
      { kind: "text", text: "https://evil.example/#/post/1" },
    ]);
    expect(splitPostLinks("https://bsm.backspace.fm.evil/#/post/1")[0].kind).toBe("text");
    expect(splitPostLinks(`${LINK}abc`)).toEqual([{ kind: "text", text: `${LINK}abc` }]);
    expect(splitPostLinks("https://bsm.backspace.fm/#/post/0")[0].kind).toBe("text");
  });

  it("accepts extra origins (dev)", () => {
    const parts = splitPostLinks("http://localhost:3000/#/post/9", ["https://bsm.backspace.fm", "http://localhost:3000"]);
    expect(parts).toEqual([{ kind: "post", text: "http://localhost:3000/#/post/9", postId: 9 }]);
  });

  it("returns the full quote's link", () => {
    const body = quoteText({ authorName: "A", text: "x", hasImages: false, permalink: LINK });
    expect(splitPostLinks(body).filter((p) => p.kind === "post")).toHaveLength(1);
  });
});

describe("a quote is about the post, not the article it links to", () => {
  const LINK2 = "https://bsm.backspace.fm/#/post/8729";
  it("drops pasted URLs from the excerpt, uses the link card's title for a link-only post", () => {
    expect(quoteText({ authorName: "NORIO", text: "https://share.google/zFOWugfJDxbbvwVRe", hasImages: false, permalink: LINK2, linkTitle: "ソニー、ウォークマンZXシリーズ最新モデル「NW-ZX900」を海外発表" }))
      .toBe(`📝 NORIO さんの投稿「ソニー、ウォークマンZXシリーズ最新モデル「NW-ZX900」を海外発表」\n${LINK2}\n`);
    expect(quoteText({ authorName: "Kenta", text: "これは試す価値ありそうだな https://l.smartnews.com/m-8lgVyveg/bL5jK9", hasImages: false, permalink: LINK2 }))
      .toBe(`📝 Kenta さんの投稿「これは試す価値ありそうだな」\n${LINK2}\n`);
    expect(quoteText({ authorName: "a", text: "https://example.com/x", hasImages: false, permalink: LINK2 }))
      .toBe(`📝 a さんの投稿「リンク」\n${LINK2}\n`);
  });
});
