/* 📝 URL から題名と一言の補完（lib/neta-urlinfo.ts）の小物。外には出ない（ネットにつながない）。 */
import { describe, it, expect } from "vitest";
import { clean, isPrivateIp, isXUrl, parseHtmlMeta, parseXStatus, publicHttpUrl, urlInfoRateOk, fetchNetaUrlInfo } from "../neta-urlinfo";

describe("宛先の確かめ（SSRF）", () => {
  it("内部・ループバック・リンクローカル・CGNAT の IP は断る", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.100.1.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "153.127.198.207", "2606:4700::1111"]) expect(isPrivateIp(ip), ip).toBe(false);
  });
  it("http(s)・80/443 だけ、資格情報・localhost・内部の IP の URL は通さない", () => {
    expect(publicHttpUrl("https://example.com/a?b=1")?.hostname).toBe("example.com");
    for (const bad of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "https://user:pw@example.com/",
      "https://example.com:8443/",
      "http://intranet/",
      "http://foo.internal/",
      "javascript:alert(1)",
      "",
      "x".repeat(3000),
    ]) {
      expect(publicHttpUrl(bad), bad).toBeNull();
    }
  });
  it("断る URL は外に出ずに答える", async () => {
    const r = await fetchNetaUrlInfo("http://127.0.0.1:3000/");
    expect(r).toMatchObject({ title: "", note: "URL が正しくありません" });
  });
  it("Google ニュースは取らずに案内", async () => {
    const r = await fetchNetaUrlInfo("https://news.google.com/articles/abc");
    expect(r.title).toBe("");
    expect(r.note).toContain("元の記事の URL");
  });
});

describe("ページの読み取り", () => {
  it("meta の属性の順番によらず読む・og を優先・実体参照を戻す", () => {
    const html = `<html><head><title>素の題名</title>
      <meta content="説明 &amp; 一言" name="description">
      <meta property='og:title' content='OG の題名 &#x2764;'>
      </head></html>`;
    const m = parseHtmlMeta(html);
    expect(m.title).toBe("OG の題名 &#x2764;");
    expect(clean(m.title, 200)).toBe("OG の題名 ❤");
    expect(clean(m.description, 1000)).toBe("説明 & 一言");
  });
  it("og がなければ <title>", () => {
    expect(parseHtmlMeta("<title>\n  記事 | サイト\n</title>").title.trim()).toBe("記事 | サイト");
  });
  it("長いものは切って …", () => {
    expect(Array.from(clean("あ".repeat(300), 200)).length).toBe(200);
    expect(clean("a\n\tb  c", 10)).toBe("a b c");
  });
});

describe("X の URL", () => {
  it("x.com / twitter.com / mobile のポストを見分ける", () => {
    expect(parseXStatus("https://x.com/jack/status/20")).toEqual({ user: "jack", id: "20" });
    expect(parseXStatus("https://mobile.twitter.com/jack/status/20?s=20")).toEqual({ user: "jack", id: "20" });
    expect(parseXStatus("https://x.com/jack")).toBeNull();
    expect(parseXStatus("https://notx.com/jack/status/20")).toBeNull();
    expect(isXUrl("https://www.twitter.com/a")).toBe(true);
    expect(isXUrl("https://x.com.evil.example/a")).toBe(false);
  });
});

describe("回数の上限", () => {
  it("1 分 20 回まで", () => {
    const now = 1_000_000;
    for (let i = 0; i < 20; i++) expect(urlInfoRateOk("k", now)).toBe(true);
    expect(urlInfoRateOk("k", now)).toBe(false);
    expect(urlInfoRateOk("k", now + 61_000)).toBe(true);
  });
});
