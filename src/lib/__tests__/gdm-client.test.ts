/* 👥 グループ DM の Web クライアントの純粋な部分（lib/gdm-client.ts）。 */
import { describe, it, expect } from "vitest";
import { applyToGroups, pruneExpiredG, reconcileG, type GMessage, type GroupSummary } from "../gdm-client";
import { groupTitle, normalizeGroupName } from "../gdm";

const msg = (p: Partial<GMessage>): GMessage => ({
  id: 1,
  group_id: 7,
  kind: "text",
  from_id: "u1",
  from_name: "ねこ",
  from_avatar: null,
  body: "x",
  created_at: new Date().toISOString(),
  is_author: false,
  ...p,
});
const group = (id: number, unread = 0): GroupSummary => ({
  group: { id, name: null, title: "g", members: [], member_count: 2, is_creator: false, muted: false, created_at: new Date().toISOString() },
  last_message: null,
  unread_count: unread,
});

describe("gdm-client", () => {
  it("reconcileG: client_id の楽観的な吹き出しを置き換え、ID 順（送信中は最後）", () => {
    const temp = msg({ id: -1, client_id: "c1", pending: true, is_author: true });
    const other = msg({ id: 5 });
    const real = msg({ id: 9, client_id: "c1", is_author: true });
    const out = reconcileG([temp, other], real);
    expect(out.map((m) => m.id)).toEqual([5, 9]);
    expect(out[1].pending).toBe(false);
    expect(reconcileG([msg({ id: -2, pending: true }), other], msg({ id: 3 })).map((m) => m.id)).toEqual([3, 5, -2]);
  });

  it("applyToGroups: 人の発言だけ未読 +1、自分・system・見ているときは増えない、先頭へ。知らないグループは null", () => {
    const list = [group(1), group(7, 2)];
    expect(applyToGroups(list, msg({}), false)?.[0]).toMatchObject({ unread_count: 3 });
    expect(applyToGroups(list, msg({}), false)?.[0].group.id).toBe(7);
    expect(applyToGroups(list, msg({ is_author: true }), false)?.[0].unread_count).toBe(2);
    expect(applyToGroups(list, msg({ kind: "system", from_id: null }), false)?.[0].unread_count).toBe(2);
    expect(applyToGroups(list, msg({}), true)?.[0].unread_count).toBe(0);
    expect(applyToGroups(list, msg({ group_id: 99 }), false)).toBeNull();
  });

  it("pruneExpiredG: 30 日を過ぎたものを落とす（送信中は残す）", () => {
    const old = new Date(Date.now() - 31 * 24 * 3600_000).toISOString();
    expect(pruneExpiredG([msg({ created_at: old }), msg({ created_at: old, pending: true }), msg({})])).toHaveLength(2);
  });

  it("グループ名の正規化と表示名", () => {
    expect(normalizeGroupName("  a\nb ")).toEqual({ ok: true, name: "a b" });
    expect(normalizeGroupName("")).toEqual({ ok: true, name: null });
    expect(normalizeGroupName(null)).toEqual({ ok: true, name: null });
    expect(normalizeGroupName(3)).toEqual({ ok: false });
    expect(normalizeGroupName("🍣".repeat(40)).ok).toBe(true); // 文字数は見た目の 1 文字で数える
    expect(normalizeGroupName("あ".repeat(41)).ok).toBe(false);
    expect(groupTitle(null, ["a", null])).toBe("a、だれか");
  });
});

describe("pickerCandidates（会員の総数を出さない）", () => {
  const members = Array.from({ length: 50 }, (_, i) => ({ userId: `u${i}`, name: i === 0 ? "ビーグル" : `会員${i}` }));
  const peers = [{ user_id: "u3", name: "会員3" }, { user_id: "p1", name: "ともだち" }];
  it("何も打っていなければ 1 対 1 の相手だけ（全員の一覧は出さない）", async () => {
    const { pickerCandidates } = await import("../gdm-client");
    expect(pickerCandidates(members, peers, new Set(), "").map((x) => x.value)).toEqual(["u3", "p1"]);
    expect(pickerCandidates(members, [], new Set(), "  ")).toEqual([]);
  });
  it("打ったら名前に含む人だけ、10 人まで。ビーグル・除く人は出さない。選んだ人は残す", async () => {
    const { pickerCandidates, PICKER_LIMIT } = await import("../gdm-client");
    const hit = pickerCandidates(members, peers, new Set(["u5"]), "会員");
    expect(hit.length).toBe(PICKER_LIMIT);
    expect(hit.map((x) => x.value)).not.toContain("u5");
    expect(pickerCandidates(members, peers, new Set(), "ビーグル")).toEqual([]);
    expect(pickerCandidates(members, peers, new Set(), "会員1", [{ value: "u2", label: "会員2" }])[0]).toEqual({ value: "u2", label: "会員2" });
  });
});
