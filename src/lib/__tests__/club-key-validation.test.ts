import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * 部活ピン / 目玉（非表示）の API は、部活キーを DB（clubs.active）で検証する。
 * 静的 seed（club-catalog.ts の allClubs()）で検証していた頃は、admin が後から
 * 追加した部活（例: 今日の一撮 = dailyshot）が「不正な部活キー」で 400 になっていた
 * （2026-10-17 本番で確認）。
 */

const active = new Set(["camera", "dailyshot"]);
vi.mock("@/lib/club-store", () => ({ isActiveClubKey: async (k: string) => active.has(k) }));
vi.mock("@/lib/session", () => ({ getSessionEmail: async () => "a@b.c" }));
const setClubPinned = vi.fn(async () => true);
vi.mock("@/lib/club-pins", () => ({ getPinnedClubs: async () => [], setClubPinned: (...a: unknown[]) => setClubPinned(...(a as [])) }));
const setClubHidden = vi.fn(async () => true);
vi.mock("@/lib/club-visibility", () => ({ getHiddenClubs: async () => new Set(), setClubHidden: (...a: unknown[]) => setClubHidden(...(a as [])) }));

import { PUT as pinsPUT } from "../../app/api/clubs/pins/route";
import { PUT as visPUT } from "../../app/api/clubs/visibility/route";

const req = (body: unknown) =>
  new Request("http://x", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;

beforeEach(() => {
  setClubPinned.mockClear();
  setClubHidden.mockClear();
});

describe("部活キーの検証は DB の active 部活で行う", () => {
  it("後から追加した部活をピンできる", async () => {
    expect((await pinsPUT(req({ club: "dailyshot", pinned: true }))).status).toBe(200);
  });
  it("存在しない部活・未設定はピンできない", async () => {
    expect((await pinsPUT(req({ club: "nope", pinned: true }))).status).toBe(400);
    expect((await pinsPUT(req({ club: "__unset__", pinned: true }))).status).toBe(400);
    expect(setClubPinned).not.toHaveBeenCalled();
  });
  it("削除済み部活のピンは外せる（行を残さない）", async () => {
    expect((await pinsPUT(req({ club: "retired", pinned: false }))).status).toBe(200);
  });
  it("後から追加した部活と未設定を非表示にできる", async () => {
    expect((await visPUT(req({ club: "dailyshot", hidden: true }))).status).toBe(200);
    expect((await visPUT(req({ club: "__unset__", hidden: true }))).status).toBe(200);
  });
  it("存在しない部活は非表示にできない", async () => {
    expect((await visPUT(req({ club: "nope", hidden: true }))).status).toBe(400);
    expect(setClubHidden).not.toHaveBeenCalled();
  });
});
