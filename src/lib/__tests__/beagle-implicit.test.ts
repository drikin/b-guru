/**
 * 🐶 @ なしの返事の決まり（lib/beagle-server.ts）: 名前の呼びかけ・候補にしない発言・判定の答えの読み方。
 */
import { describe, expect, it } from "vitest";
import { implicitCandidateText, judgeOk, judgeSaysBeagle, namesBeagle, JUDGE_PER_MEMBER_DAY } from "../beagle-server";
import { asksBeagle, beagleAnsweredWithin, noteBeagleAnswered, stripBeagleCall } from "../beagle-call";
import { sanitizeBeagleAnswer } from "../beagle-ondevice";
import { isLookupTask, looksLikeReminder } from "../beagle-reminder-time";
import { placeIn } from "../beagle-lookup";
import { taskText } from "../beagle-reminders";

describe("@ なしの返事", () => {
  it("namesBeagle", () => {
    expect(namesBeagle("ねえビーグル、今日って何曜日？")).toBe(true);
    expect(namesBeagle("ビーグルはどう思う？")).toBe(true);
    expect(namesBeagle("ありがとうビーグル")).toBe(true);
    expect(namesBeagle("うちのビーグル犬かわいい")).toBe(false);
    expect(namesBeagle("@ビーグル こんにちは")).toBe(false);
    expect(namesBeagle("ザビーグルズのライブ")).toBe(false);
    expect(namesBeagle("今日は雨")).toBe(false);
    expect(namesBeagle("ビーグルさん、ありがとう")).toBe(true);
  });
  it("implicitCandidateText", () => {
    expect(implicitCandidateText("それの重さは？")).toBe(true);
    expect(implicitCandidateText("@ドリキン それどう？")).toBe(false);
    expect(implicitCandidateText("＠みけ ありがとう")).toBe(false);
    expect(implicitCandidateText("   ")).toBe(false);
    expect(implicitCandidateText("あ".repeat(401))).toBe(false);
  });
  it("judgeSaysBeagle", () => {
    expect(judgeSaysBeagle('{"to_beagle": true}')).toBe(true);
    expect(judgeSaysBeagle('答え: {"to_beagle":true} です')).toBe(true);
    expect(judgeSaysBeagle('{"to_beagle": false}')).toBe(false);
    expect(judgeSaysBeagle('{"to_beagle": "true"}')).toBe(false);
    expect(judgeSaysBeagle("たぶん true")).toBe(false);
  });

  it("judgeOk は 1 人 1 日まで", () => {
    const now = Date.now();
    for (let i = 0; i < JUDGE_PER_MEMBER_DAY; i++) expect(judgeOk("j@test.local", now)).toBe(true);
    expect(judgeOk("j@test.local", now)).toBe(false);
    expect(judgeOk("j@test.local", now + 25 * 3600_000)).toBe(true);
  });
  it("最後に答えた時刻", () => {
    noteBeagleAnswered("W@test.local", 1_000_000);
    expect(beagleAnsweredWithin("w@test.local", 180_000, 1_100_000)).toBe(true);
    expect(beagleAnsweredWithin("w@test.local", 180_000, 1_300_000)).toBe(false);
    expect(beagleAnsweredWithin("x@test.local", 180_000, 1_100_000)).toBe(false);
  });
});

describe("呼びかけ・調べもの・出す文", () => {
  it("@ビーグル は敬称つきも", () => {
    expect(asksBeagle("@ビーグルさん 教えて")).toBe(true);
    expect(asksBeagle("＠ビーグル 教えて")).toBe(true);
    expect(asksBeagle("@ビーグルくん")).toBe(true);
    expect(asksBeagle("@ビーグルズ")).toBe(false);
    expect(stripBeagleCall("@ビーグルさん 3分後").trim()).toBe("3分後");
  });
  it("DM を送って、もリマインド", () => {
    expect(looksLikeReminder("@ビーグル 30秒後にDM送ってください")).toBe(true);
    expect(looksLikeReminder("@ビーグル DM ってどう送るの？")).toBe(false);
  });
  it("調べものの予定・場所", () => {
    expect(isLookupTask("最新の天気予報")).toBe(true);
    expect(isLookupTask("今日のニュースのまとめ")).toBe(true);
    expect(isLookupTask("カップ麺")).toBe(false);
    expect(placeIn("最新の天気予報")).toBeNull();
    expect(placeIn("東京の天気予報")).toBe("東京");
  });
  it("裸のドメインも出さない", () => {
    expect(sanitizeBeagleAnswer("ここ evil.example.com/login を見て", 100)).toBe("ここ  を見て");
    expect(sanitizeBeagleAnswer("Node.js と B-guru", 100)).toBe("Node.js と B-guru");
  });
  it("調べものの答えの文", () => {
    expect(taskText({ audience: "everyone", text: "東京の天気予報" }, "ドリキン", "晴れだわん", false)).toBe(
      "📣 ドリキンさんに頼まれた「東京の天気予報」だわん\n晴れだわん"
    );
    expect(taskText({ audience: "me", text: "ニュース" }, null, "…", true)).toBe("⏰ 頼まれた「ニュース」だわん（遅れてごめんわん）\n…");
  });
});
