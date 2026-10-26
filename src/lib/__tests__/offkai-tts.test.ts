/**
 * 🍻 チャットの読み上げの文（docs/offkai-spec.md「チャットの読み上げ」）:
 *  - 「〇〇さん、本文」、名前が無ければ本文だけ
 *  - URL は「リンク」、80 文字を超えたら「、以下略」
 *  - 写真だけなら「〇〇さんが写真を送りました」、何も無ければ読まない
 */
import { describe, it, expect } from "vitest";
import { MAX_CHARS, speechText } from "../offkai-tts";

describe("読み上げの文", () => {
  it("名前と本文", () => {
    expect(speechText("コバン", "乾杯！")).toBe("コバンさん、乾杯！");
    expect(speechText(null, "乾杯！")).toBe("乾杯！");
    expect(speechText("  ", "乾杯！")).toBe("乾杯！");
  });

  it("URL はリンク、改行と空白はまとめる", () => {
    expect(speechText("ゆう", "これ見て https://example.com/a?b=1\n\nすごい")).toBe("ゆうさん、これ見て リンク すごい");
  });

  it("長い本文は切る（文字は絵文字も 1 字）", () => {
    const long = "あ".repeat(MAX_CHARS + 5);
    expect(speechText("A", long)).toBe(`Aさん、${"あ".repeat(MAX_CHARS)}、以下略`);
    expect(speechText("A", "🍺".repeat(MAX_CHARS))).toBe(`Aさん、${"🍺".repeat(MAX_CHARS)}`);
  });

  it("写真だけ・空", () => {
    expect(speechText("たけし", "", 2)).toBe("たけしさんが写真を送りました");
    expect(speechText(null, "  ", 1)).toBe("写真が送られました");
    expect(speechText("たけし", "", 0)).toBeNull();
    expect(speechText("たけし", "おいしい", 1)).toBe("たけしさん、おいしい");
  });
});

describe("読み上げの順番", () => {
  it("URL の直後の日本語は残す・切る前の空白は落とす", () => {
    expect(speechText("A", "詳細はhttps://a.b/c）を見て")).toBe("Aさん、詳細はリンク）を見て");
    expect(speechText("A", "あ".repeat(MAX_CHARS - 1) + " い")).toBe(`Aさん、${"あ".repeat(MAX_CHARS - 1)}、以下略`);
  });
});
