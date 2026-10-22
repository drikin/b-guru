import { describe, expect, it } from "vitest";
import { splitChatUrls } from "../chat-links";

const urls = (t: string) => splitChatUrls(t).filter((p) => p.url).map((p) => p.text);

describe("splitChatUrls", () => {
  it("finds a URL in the middle of Japanese text and keeps the rest", () => {
    const parts = splitChatUrls("これ見て https://example.com/a?b=1#c 面白い");
    expect(parts).toEqual([
      { text: "これ見て ", url: false },
      { text: "https://example.com/a?b=1#c", url: true },
      { text: " 面白い", url: false },
    ]);
  });
  it("leaves Japanese and ASCII punctuation outside the link", () => {
    expect(urls("見た？https://example.com/x。")).toEqual(["https://example.com/x"]);
    expect(urls("see https://example.com/x, ok")).toEqual(["https://example.com/x"]);
    expect(urls("（https://example.com/x）")).toEqual(["https://example.com/x"]);
    expect(urls("(see https://example.com/x)")).toEqual(["https://example.com/x"]);
  });
  it("keeps balanced parentheses that belong to the URL", () => {
    expect(urls("https://en.wikipedia.org/wiki/Foo_(bar)")).toEqual(["https://en.wikipedia.org/wiki/Foo_(bar)"]);
  });
  it("finds several URLs and ignores a bare scheme", () => {
    expect(urls("http://a.jp と https://b.jp/ と https://")).toEqual(["http://a.jp", "https://b.jp/"]);
  });
  it("returns the text as one plain part when there is no URL", () => {
    expect(splitChatUrls("@ドリキン こんにちは")).toEqual([{ text: "@ドリキン こんにちは", url: false }]);
  });
});
