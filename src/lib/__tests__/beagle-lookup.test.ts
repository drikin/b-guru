import { describe, expect, it } from "vitest";
import { dayIn, placeIn, subjectIn, weatherWord } from "@/lib/beagle-lookup";

// 🐶 ビーグルの調べもの: 質問から地名・日・調べる言葉を取り出す（lib/beagle-lookup.ts）。
describe("beagle lookup", () => {
  it("天気の質問の地名と日", () => {
    expect(placeIn("明日の久留米の天気は？")).toBe("久留米");
    expect(placeIn("今日の東京の天気どう？")).toBe("東京");
    expect(placeIn("あさって大阪は雨降る？")).toBe("大阪");
    expect(placeIn("明日の天気は？")).toBeNull();
    expect(dayIn("明日の久留米の天気は？")).toBe(1);
    expect(dayIn("あさって大阪は雨降る？")).toBe(2);
    expect(dayIn("今日の東京の天気")).toBe(0);
  });

  it("〇〇って誰／何／とは・〇〇は誰（「赤は何個」は拾わない）", () => {
    expect(subjectIn("樋口監督って誰？")).toBe("樋口監督");
    expect(subjectIn("久留米市ってどんなところ？")).toBe("久留米市");
    expect(subjectIn("Foundation Modelsとは何？")).toBe("Foundation Models");
    expect(subjectIn("ドリキンは誰？")).toBe("ドリキン");
    expect(subjectIn("赤いボールが3個、青いボールが5個。赤を2個足すと赤は何個？")).toBeNull();
    expect(subjectIn("こんばんは")).toBeNull();
  });

  it("天気コード", () => {
    expect(weatherWord(0)).toBe("晴れ");
    expect(weatherWord(61)).toBe("雨");
    expect(weatherWord(3)).toBe("くもり");
  });
});
