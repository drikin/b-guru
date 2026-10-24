import { describe, expect, it } from "vitest";
import { asksBeagle, beagleAiAuthorName, sanitizeBeagleAnswer } from "@/lib/beagle-ondevice";
import { isReservedDisplayName } from "@/lib/profile";

// 🐶 端末内 AI のビーグル: 呼ばれたかの判定・出す本文の整え方・名前（lib/beagle-ondevice.ts）。
describe("beagle on-device", () => {
  it("@ビーグル で呼ばれたか（名前の一部は呼んでいない）", () => {
    expect(asksBeagle("@ビーグル 今日のおすすめは？")).toBe(true);
    expect(asksBeagle("ねえ @ビーグル")).toBe(true);
    expect(asksBeagle("@ビーグル、元気？")).toBe(true);
    expect(asksBeagle("@ビーグルズ のライブ")).toBe(false);
    expect(asksBeagle("ビーグル かわいい")).toBe(false);
  });

  it("本文: URL を取り、@ は全角に（呼び出しにしない）、500 字まで、空なら null", () => {
    expect(sanitizeBeagleAnswer("見てね https://evil.example/x だわん")).toBe("見てね  だわん");
    expect(sanitizeBeagleAnswer("@ドリキン さんに聞くわん @here")).toBe("＠ドリキン さんに聞くわん ＠here");
    expect(sanitizeBeagleAnswer("   ")).toBeNull();
    expect(sanitizeBeagleAnswer(42)).toBeNull();
    const long = sanitizeBeagleAnswer("わ".repeat(800))!;
    expect([...long].length).toBe(500);
    expect(long.endsWith("…")).toBe(true);
  });

  it("発言者名は誰の端末かを入れる", () => {
    expect(beagleAiAuthorName("ドリキン")).toBe("ビーグル（ドリキンさんの端末）");
    expect(beagleAiAuthorName(null)).toBe("ビーグル（会員さんの端末）");
  });

  it("会員は ビーグル・B-guru を名乗れない", () => {
    for (const n of ["ビーグル", "ビーグル（ドリキンさんの端末）", "ﾋﾞｰｸﾞﾙ", "Beagle", "B-guru", "bguru"]) expect(isReservedDisplayName(n)).toBe(true);
    for (const n of ["ドリキン", "犬好きのビーグル党", "mazzo"]) expect(isReservedDisplayName(n)).toBe(false);
  });
});

describe("plainText（マークダウンを吹き出し向けに）", () => {
  it("太字・見出し・箇条書き・リンク・コード", async () => {
    const { plainText } = await import("@/lib/beagle-ondevice");
    expect(plainText("今日のハイライトだわん：\n\n- **りきとさん**が 300円でベスト盤\n- **takutoさん**が Bluetooth")).toBe(
      "今日のハイライトだわん：\n\n・りきとさんが 300円でベスト盤\n・takutoさんが Bluetooth"
    );
    expect(plainText("## 見出し\n1) 一つ目\n* 二つ目\n> 引用")).toBe("見出し\n1. 一つ目\n・二つ目\n引用");
    expect(plainText("[記事](https://x.example) と `code` と __強調__")).toBe("記事 と code と 強調");
    expect(plainText("3 * 4 = 12 だわん")).toBe("3 * 4 = 12 だわん");
  });
});
