import { describe, it, expect } from "vitest";
import {
  charsetFromContentType,
  charsetFromHead,
  decodeHtmlBytes,
  extractSpotify,
} from "../urlpreview";

/** 文字列を utf-8 のバイト列に変換。 */
function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Shift-JIS バイト列を組み立てる。ASCII は 1:1 (latin1)、日本語は hex 定数で結合。
 *  Node の Buffer は shift_jis エンコード非対応のため、事前エンコード済み hex を使う。 */
const SJIS = {
  // "企業がポッドキャストを始めるのは、なぜ？"
  title: Buffer.from("8ae98bc682aa837c83628368834c83838358836782f08e6e82df82e982cc82cd814182c882ba8148", "hex"),
  // "じわじわ効く「声」の力"
  body: Buffer.from("82b682ed82b682ed8cf882ad817590ba817682cc97cd", "hex"),
  // "日本語タイトル"
  jp: Buffer.from("93fa967b8cea835e83438367838b", "hex"),
};
function sjisBytes(parts: Array<string | Buffer>): Uint8Array {
  const bs = parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : p));
  return new Uint8Array(Buffer.concat(bs));
}

describe("charsetFromContentType", () => {
  it("charset 宣言を取り出す", () => {
    expect(charsetFromContentType("text/html; charset=Shift_JIS")).toBe("Shift_JIS");
  });
  it("小文字・クォット付きでも取り出す", () => {
    expect(charsetFromContentType('text/html; charset="utf-8"')).toBe("utf-8");
  });
  it("宣言が無ければ undefined", () => {
    expect(charsetFromContentType("text/html")).toBeUndefined();
    expect(charsetFromContentType(null)).toBeUndefined();
    expect(charsetFromContentType(undefined)).toBeUndefined();
  });
});

describe("charsetFromHead", () => {
  it("http-equiv meta の Shift-JIS 宣言を検出", () => {
    const html = `<!DOCTYPE html><html><head><meta http-equiv="content-type" content="text/html;charset=shift_jis"><title>x</title></head><body></body></html>`;
    expect(charsetFromHead(utf8Bytes(html))).toBe("shift_jis");
  });
  it("<meta charset> 形式も検出", () => {
    const html = `<head><meta charset="EUC-JP"><title>x</title></head>`;
    expect(charsetFromHead(utf8Bytes(html))).toBe("euc-jp");
  });
  it("UTF-8 宣言なら utf-8", () => {
    const html = `<head><meta charset="UTF-8"></head>`;
    expect(charsetFromHead(utf8Bytes(html))).toBe("utf-8");
  });
  it("宣言がなければ utf-8（既定）", () => {
    const html = `<head><title>no charset here</title></head>`;
    expect(charsetFromHead(utf8Bytes(html))).toBe("utf-8");
  });
  it("空バイト列でも utf-8", () => {
    expect(charsetFromHead(utf8Bytes(""))).toBe("utf-8");
  });
});

describe("decodeHtmlBytes", () => {
  it("UTF-8 ページはそのまま（既定パスで化けない）", () => {
    const html = `<head><meta charset="utf-8"><title>日本語タイトル</title></head>`;
    const out = decodeHtmlBytes(utf8Bytes(html), "text/html; charset=utf-8");
    expect(out).toContain("日本語タイトル");
    expect(out).not.toContain("\uFFFD");
  });

  it("Shift-JIS ページを正しくデコード（itmedia パターン：ヘッダ無宣言＋HTML内で shift_jis）", () => {
    const bytes = sjisBytes([
      `<html><head><meta http-equiv="content-type" content="text/html;charset=shift_jis"><title>`,
      SJIS.title,
      `</title></head><body>`,
      SJIS.body,
      `</body></html>`,
    ]);
    const out = decodeHtmlBytes(bytes, "text/html");
    expect(out).toContain("企業がポッドキャストを始めるのは、なぜ？");
    expect(out).toContain("じわじわ効く「声」の力");
    expect(out).not.toContain("\uFFFD");
  });

  it("Content-Type の charset 宣言を優先（HTML内に宣言が無くても）", () => {
    const bytes = sjisBytes([`<html><head><title>`, SJIS.jp, `</title></head>`]);
    const out = decodeHtmlBytes(bytes, "text/html; charset=Shift_JIS");
    expect(out).toContain("日本語タイトル");
    expect(out).not.toContain("\uFFFD");
  });

  it("UTF-8 ページを誤って Shift-JIS で読まない（既定は utf-8）", () => {
    const html = `<head><meta charset="utf-8"><title>UTF-8のタイトル</title></head>`;
    const out = decodeHtmlBytes(utf8Bytes(html), "text/html");
    expect(out).toContain("UTF-8のタイトル");
    expect(out).not.toContain("\uFFFD");
  });
});

describe("extractSpotify", () => {
  it("album / track / playlist / artist / episode / show を認識する", () => {
    expect(extractSpotify("https://open.spotify.com/album/1GZCmYFsiouBsHUP8sn6lY")).toEqual({
      kind: "album",
      id: "1GZCmYFsiouBsHUP8sn6lY",
    });
    expect(extractSpotify("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT")).toEqual({
      kind: "track",
      id: "4cOdK2wGLETKBW3PvgPWqT",
    });
    expect(extractSpotify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M")).toEqual({
      kind: "playlist",
      id: "37i9dQZF1DXcBWIGoYBM5M",
    });
    expect(extractSpotify("https://open.spotify.com/artist/0OdUWJ0sBjDrqHygGUXeCF")).toEqual({
      kind: "artist",
      id: "0OdUWJ0sBjDrqHygGUXeCF",
    });
    expect(extractSpotify("https://open.spotify.com/episode/512ojhOuo1ktJprKbVcKyQ")).toEqual({
      kind: "episode",
      id: "512ojhOuo1ktJprKbVcKyQ",
    });
    expect(extractSpotify("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk")).toEqual({
      kind: "show",
      id: "4rOoJ6Egrf8K2IrywzwOMk",
    });
  });

  it("ロケール接頭辞（/intl-ja/）付きでも認識する", () => {
    expect(extractSpotify("https://open.spotify.com/intl-ja/album/1GZCmYFsiouBsHUP8sn6lY")).toEqual({
      kind: "album",
      id: "1GZCmYFsiouBsHUP8sn6lY",
    });
  });

  it("クエリ（?si=...）付きでも認識する", () => {
    expect(
      extractSpotify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc123&pt=xyz")
    ).toEqual({ kind: "playlist", id: "37i9dQZF1DXcBWIGoYBM5M" });
  });

  it("Spotify 以外のホストは null", () => {
    expect(extractSpotify("https://example.com/album/abc")).toBeNull();
    expect(extractSpotify("https://notspotify.com/album/abc")).toBeNull();
    // サブドメイン偽装（evilspotify.com）も弾く
    expect(extractSpotify("https://evilspotify.com/album/abc")).toBeNull();
  });

  it("未対応のパス・不正な ID は null", () => {
    expect(extractSpotify("https://open.spotify.com/user/someone")).toBeNull();
    expect(extractSpotify("https://open.spotify.com/album/")).toBeNull();
    expect(extractSpotify("https://open.spotify.com/album/../../etc/passwd")).toBeNull();
    expect(extractSpotify("https://open.spotify.com/album/has-dash")).toBeNull();
  });

  it("URL でない文字列は null", () => {
    expect(extractSpotify("not a url")).toBeNull();
    expect(extractSpotify("")).toBeNull();
  });
});
