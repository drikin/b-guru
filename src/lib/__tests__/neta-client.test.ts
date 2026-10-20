/** 「ネタ帳に送る」の候補 URL（lib/neta-client.ts）。 */
import { describe, it, expect } from "vitest";
import { netaCandidates, netaDefaultTitle } from "../neta-client";

describe("netaCandidates", () => {
  it("puts the link card first, then URLs in the text, deduped", () => {
    expect(netaCandidates({
      text: "これ https://b.jp/x と https://a.jp/ も",
      urlPreview: { url: "https://a.jp/" },
    })).toEqual(["https://a.jp/", "https://b.jp/x"]);
  });
  it("strips trailing Japanese/ASCII punctuation", () => {
    expect(netaCandidates({ text: "見て（https://a.jp/n）。https://b.jp/c」 https://c.jp/d!? https://d.jp/e、", urlPreview: null }))
      .toEqual(["https://a.jp/n", "https://b.jp/c", "https://c.jp/d", "https://d.jp/e"]);
    expect(netaCandidates({ text: "https://a.jp/p】,." })).toEqual(["https://a.jp/p"]);
  });
  it("excludes B-guru itself and non-http(s)", () => {
    expect(netaCandidates({
      text: "https://bsm.backspace.fm/#/post/1 ftp://x.jp javascript:alert(1) https://neta.backspace.fm/t/1",
      urlPreview: { url: "https://BSM.backspace.fm/#/post/2" },
    })).toEqual(["https://neta.backspace.fm/t/1"]);
  });
  it("is empty when there is nothing to send", () => {
    expect(netaCandidates({ text: "URL なし", urlPreview: null })).toEqual([]);
    expect(netaCandidates({})).toEqual([]);
  });
  it("dedupes equivalent URLs (trailing slash)", () => {
    expect(netaCandidates({ text: "http://a.jp http://a.jp/", urlPreview: { url: "http://a.jp" } })).toEqual(["http://a.jp/"]);
  });
});

describe("netaDefaultTitle", () => {
  it("prefills the card title only for the card URL", () => {
    const pv = { url: "https://a.jp", title: "記事" };
    expect(netaDefaultTitle("https://a.jp/", pv)).toBe("記事");
    expect(netaDefaultTitle("https://b.jp/", pv)).toBe("");
    expect(netaDefaultTitle("https://a.jp/", null)).toBe("");
  });
});
