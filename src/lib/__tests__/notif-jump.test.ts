import { describe, it, expect } from "vitest";
import { notifJumpClub } from "../notif-jump";

const active = new Set(["car", "camera"]);
const none = new Set<string>();

describe("notifJumpClub（通知ジャンプ時の部活フィルタ）", () => {
  it("同じ部活で絞り込み中ならそのまま", () => {
    expect(notifJumpClub("car", "car", active, none)).toBe("car");
  });
  it("別の部活の投稿なら「すべて」へ（リュー 2026-10-16 の報告）", () => {
    expect(notifJumpClub("car", "camera", active, none)).toBeNull();
    expect(notifJumpClub("car", null, active, none)).toBeNull();
  });
  it("絞り込みなしなら「すべて」のまま", () => {
    expect(notifJumpClub(null, "camera", active, none)).toBeNull();
  });
  it("隠した部活の投稿はその部活へ切り替える（「すべて」に出ないため）", () => {
    expect(notifJumpClub(null, "camera", active, new Set(["camera"]))).toBe("camera");
    expect(notifJumpClub("car", "camera", active, new Set(["camera"]))).toBe("camera");
  });
  it("削除済み部活・__unset__ の投稿は「未設定」枠として扱う", () => {
    expect(notifJumpClub(null, "retired", active, new Set(["__unset__"]))).toBe("__unset__");
    expect(notifJumpClub("__unset__", "__unset__", active, none)).toBe("__unset__");
    expect(notifJumpClub(null, "retired", active, none)).toBeNull();
  });
  it("未分類（club=NULL）は隠せないので常に「すべて」", () => {
    expect(notifJumpClub(null, null, active, new Set(["__unset__"]))).toBeNull();
  });
});
