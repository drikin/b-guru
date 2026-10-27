/**
 * 🐶 ビーグルのリマインドの決まり（lib/beagle-reminder-time.ts、docs/beagle-reminders-spec.md）:
 *  - 日本時間の計算と繰り返しの次の回（毎日・平日・毎週・毎月、月末）
 *  - 依頼の判定・一覧・取り消し・短いタイマー
 *  - AI の JSON の確かめ（過去・範囲・夜中の全員向け・事前のお知らせ）
 */
import { describe, expect, it } from "vitest";
import {
  beforeLabel,
  cleanText,
  fromJst,
  isListCommand,
  jst,
  jstLabel,
  looksLikeReminder,
  nextRepeat,
  parseCancel,
  parseJstLocal,
  parseQuickTimer,
  planFromAi,
  repeatLabel,
} from "../beagle-reminder-time";
import { fireText } from "../beagle-reminders";

// 2026-10-27（火）15:40 JST
const NOW = fromJst(2026, 10, 27, 15, 40);

describe("日本時間", () => {
  it("round-trips and labels", () => {
    expect(jst(NOW)).toMatchObject({ y: 2026, mo: 10, d: 27, h: 15, mi: 40, wd: 2 });
    expect(NOW.toISOString()).toBe("2026-10-27T06:40:00.000Z");
    expect(jstLabel(fromJst(2026, 10, 28, 9, 5), NOW)).toBe("10/28（水）9:05");
    expect(jstLabel(fromJst(2027, 1, 2, 9, 0), NOW)).toBe("2027/1/2（土）9:00");
  });
  it("parses YYYY-MM-DDTHH:mm as JST and rejects impossible dates", () => {
    expect(parseJstLocal("2026-10-28T09:00")?.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(parseJstLocal("2026-02-30T09:00")).toBeNull();
    expect(parseJstLocal("明日")).toBeNull();
  });
});

describe("繰り返し", () => {
  it("daily / weekdays / weekly / monthly", () => {
    expect(jstLabel(nextRepeat({ freq: "daily", time: "21:00" }, NOW), NOW)).toBe("10/27（火）21:00");
    expect(jstLabel(nextRepeat({ freq: "daily", time: "08:00" }, NOW), NOW)).toBe("10/28（水）8:00");
    // 金曜の夜 → 次の平日は月曜
    const fri = fromJst(2026, 10, 30, 22, 0);
    expect(jstLabel(nextRepeat({ freq: "weekdays", time: "08:00" }, fri), fri)).toBe("11/2（月）8:00");
    expect(jstLabel(nextRepeat({ freq: "weekly", time: "21:00", weekdays: [3] }, NOW), NOW)).toBe("10/28（水）21:00");
    expect(jstLabel(nextRepeat({ freq: "weekly", time: "15:00", weekdays: [2] }, NOW), NOW)).toBe("11/3（火）15:00");
    expect(jstLabel(nextRepeat({ freq: "monthly", time: "10:00", day: 25 }, NOW), NOW)).toBe("11/25（水）10:00");
    // 31 日は月末に寄せる
    expect(jstLabel(nextRepeat({ freq: "monthly", time: "10:00", day: 31 }, fromJst(2026, 11, 1, 0, 0)), NOW)).toBe("11/30（月）10:00");
    expect(repeatLabel({ freq: "weekly", time: "21:00", weekdays: [1, 3] })).toBe("毎週月・水曜 21:00");
  });
});

describe("依頼の判定", () => {
  it("looksLikeReminder", () => {
    expect(looksLikeReminder("@ビーグル 3分後に教えて")).toBe(true);
    expect(looksLikeReminder("@ビーグル 25分タイマー")).toBe(true);
    expect(looksLikeReminder("@ビーグル 明日 9 時にゴミ出しをリマインド")).toBe(true);
    expect(looksLikeReminder("@ビーグル 毎週水曜21時に配信の準備を知らせて")).toBe(true);
    expect(looksLikeReminder("@ビーグル Swift について教えて")).toBe(false);
    expect(looksLikeReminder("@ビーグル 明日の天気は？")).toBe(false);
    expect(looksLikeReminder("@ビーグル こんばんは")).toBe(false);
  });
  it("list and cancel", () => {
    expect(isListCommand("@ビーグル リマインド一覧")).toBe(true);
    expect(isListCommand("@ビーグル 予定のリスト")).toBe(true);
    expect(parseCancel("@ビーグル リマインド取り消し 12 13")).toEqual({ all: false, ids: [12, 13] });
    expect(parseCancel("@ビーグル リマインド全部取り消し")).toEqual({ all: true, ids: [] });
    expect(parseCancel("@ビーグル 取り消しって何？")).toBeNull();
  });
  it("quick timers (no AI)", () => {
    expect(parseQuickTimer("@ビーグル 3分後に教えて")).toEqual({ ms: 180_000, text: "" });
    expect(parseQuickTimer("@ビーグル 25分タイマー")).toEqual({ ms: 1_500_000, text: "" });
    expect(parseQuickTimer("@ビーグル 1時間30分後にカップ麺を教えて")).toEqual({ ms: 5_400_000, text: "カップ麺" });
    expect(parseQuickTimer("@ビーグル カップ麺 3分タイマー")).toEqual({ ms: 180_000, text: "カップ麺" });
    expect(parseQuickTimer("@ビーグル 明日 3分後")).toBeNull();
    expect(parseQuickTimer("@ビーグル みんなに 5分後に知らせて")).toBeNull();
    expect(parseQuickTimer("@ビーグル 25時間後に教えて")).toBeNull(); // 24 時間まで
    expect(parseQuickTimer("@ビーグル 5秒後")).toBeNull(); // 10 秒から
  });
  it("cleanText drops URLs and mentions", () => {
    expect(cleanText("見て https://x.example/a @ドリキン さん")).toBe("見て ＠ドリキン さん");
    expect(cleanText("あ".repeat(150))).toHaveLength(100);
  });
});

describe("AI の答えの確かめ", () => {
  it("at / repeat / event / timer / none", () => {
    const at = planFromAi({ action: "create", kind: "at", audience: "me", text: "ゴミ出し", at: "2026-10-28T09:00" }, NOW);
    expect("plan" in at && at.plan.fires[0].toISOString()).toBe("2026-10-28T00:00:00.000Z");
    const rep = planFromAi({ action: "create", kind: "repeat", audience: "me", text: "配信", repeat: { freq: "weekly", time: "21:00", weekdays: [3] } }, NOW);
    expect("plan" in rep && jstLabel(rep.plan.fires[0], NOW)).toBe("10/28（水）21:00");
    const ev = planFromAi({ action: "create", kind: "event", audience: "everyone", text: "オフ会", at: "2026-10-30T20:00", before_minutes: [1440, 60] }, NOW);
    expect("plan" in ev && ev.plan.fires.map((t) => jstLabel(t, NOW))).toEqual(["10/29（木）20:00", "10/30（金）19:00"]);
    const t = planFromAi({ action: "create", kind: "timer", audience: "me", text: "", after_seconds: 300 }, NOW);
    expect("plan" in t && t.plan.fires[0].getTime() - NOW.getTime()).toBe(300_000);
    expect(planFromAi({ action: "none" }, NOW)).toEqual({ none: true });
  });
  it("refuses the past, far future, bad shapes and night-time announcements", () => {
    expect(planFromAi({ action: "create", kind: "at", audience: "me", text: "", at: "2026-10-27T09:00" }, NOW)).toHaveProperty("error");
    expect(planFromAi({ action: "create", kind: "at", audience: "me", text: "", at: "2028-10-27T09:00" }, NOW)).toHaveProperty("error");
    expect(planFromAi({ action: "create", kind: "repeat", audience: "me", repeat: { freq: "hourly", time: "21:00" } }, NOW)).toHaveProperty("error");
    expect(planFromAi({ action: "create", kind: "at", audience: "everyone", text: "", at: "2026-10-28T03:00" }, NOW)).toHaveProperty("error");
    expect(planFromAi({ action: "create", kind: "repeat", audience: "everyone", repeat: { freq: "daily", time: "05:00" } }, NOW)).toHaveProperty("error");
    expect(planFromAi("oops", NOW)).toHaveProperty("error");
  });
});

describe("鳴らす文", () => {
  const fire = fromJst(2026, 10, 30, 19, 0);
  it("personal and everyone, with the asker's name", () => {
    expect(fireText({ kind: "timer", audience: "me", text: "カップ麺", event_at: null }, fire, null, false)).toBe("⏲ 時間だわん：カップ麺");
    expect(fireText({ kind: "at", audience: "me", text: "", event_at: null }, fire, null, true)).toBe("⏰ リマインドだわん！（遅れてごめんわん）");
    expect(fireText({ kind: "event", audience: "everyone", text: "オフ会", event_at: fromJst(2026, 10, 30, 20, 0) }, fire, "ドリキン", false)).toBe(
      "📣 ドリキンさんからのお知らせだわん：1 時間後に予定があるわん（10/30（金）20:00）：オフ会"
    );
    expect(beforeLabel(fromJst(2026, 10, 29, 20, 0), fromJst(2026, 10, 30, 20, 0))).toBe("明日");
  });
});
