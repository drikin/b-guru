/** ✉️ 簡易 DM の Web クライアントの純粋な部分: client_id の突き合わせ、期限切れ、一覧と未読。 */
import { describe, it, expect } from "vitest";
import { applyToConversations, pruneExpired, reconcileDm, DM_TTL_MS, type DmMessage, type DmPeer } from "../dm-client";

const peer: DmPeer = { user_id: "P", name: "ねこ", avatar: null };
function msg(id: number, over: Partial<DmMessage> = {}): DmMessage {
  return { id, from_id: "P", to_id: "ME", peer_id: "P", body: `m${id}`, created_at: new Date().toISOString(), is_author: false, ...over };
}

describe("reconcileDm", () => {
  it("自分の送信中の吹き出しを client_id で置き換える（2 回届いても 1 つ）", () => {
    const temp = msg(-1, { is_author: true, client_id: "c1", pending: true });
    let list = [msg(1), temp];
    const stored = msg(5, { is_author: true, client_id: "c1" });
    list = reconcileDm(list, stored);
    list = reconcileDm(list, { ...stored, client_id: undefined }); // 相手側と同じ形（client_id なし）でも ID で重ならない
    expect(list.map((m) => m.id)).toEqual([1, 5]);
    expect(list[1].pending).toBe(false);
  });
  it("新しいものは ID 順に足す、送信中は最後", () => {
    const list = reconcileDm([msg(1), msg(-1, { pending: true, client_id: "x" })], msg(3));
    expect(list.map((m) => m.id)).toEqual([1, 3, -1]);
  });
});

describe("pruneExpired", () => {
  it("30 日を過ぎたものを隠す（送信中は残す）", () => {
    const now = Date.now();
    const old = msg(1, { created_at: new Date(now - DM_TTL_MS - 1000).toISOString() });
    const pending = msg(-1, { created_at: new Date(now - DM_TTL_MS - 1000).toISOString(), pending: true });
    expect(pruneExpired([old, msg(2), pending], now).map((m) => m.id)).toEqual([2, -1]);
  });
});

describe("applyToConversations", () => {
  it("相手からは未読 +1・先頭へ、見ている会話は 0、自分の送信は変えない", () => {
    const other = { peer: { user_id: "Q", name: "みけ", avatar: null }, last_message: msg(1, { peer_id: "Q" }), unread_count: 2 };
    let list = applyToConversations([other], msg(2), peer, false);
    expect(list.map((c) => [c.peer.user_id, c.unread_count])).toEqual([["P", 1], ["Q", 2]]);
    list = applyToConversations(list, msg(3), peer, false);
    expect(list[0].unread_count).toBe(2);
    list = applyToConversations(list, msg(4, { is_author: true }), peer, false);
    expect(list[0].unread_count).toBe(2);
    list = applyToConversations(list, msg(5), peer, true);
    expect(list[0].unread_count).toBe(0);
    expect(list[0].last_message.id).toBe(5);
  });
});
