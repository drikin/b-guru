/* ✉️👥 DM の編集・リアクションの Web クライアントの純粋な部分（docs/dm-chat-parity-spec.md）。 */
import { describe, it, expect } from "vitest";
import { replaceEditedDm, setDmReactions, type DmMessage } from "../dm-client";
import { replaceEditedG, setGReactions, type GMessage } from "../gdm-client";

const dm = (id: number, body: string, extra: Partial<DmMessage> = {}): DmMessage => ({
  id,
  from_id: "a",
  to_id: "b",
  peer_id: "b",
  body,
  created_at: "2026-11-08T00:00:00.000Z",
  is_author: true,
  ...extra,
});
const gm = (id: number, body: string, extra: Partial<GMessage> = {}): GMessage => ({
  id,
  group_id: 1,
  kind: "text",
  from_id: "a",
  from_name: "A",
  from_avatar: null,
  body,
  created_at: "2026-11-08T00:00:00.000Z",
  is_author: true,
  ...extra,
});
const thumbs = [{ emoji: "👍", count: 1, mine: false, reactors: ["B"] }];

describe("✉️ 1 対 1", () => {
  it("直した発言を同じ ID に差し替え、届いていないリアクションは今のまま", () => {
    const list = [dm(1, "前"), dm(2, "こんにちわ", { reactions: thumbs })];
    const next = replaceEditedDm(list, dm(2, "こんにちは", { edited: true, edited_at: "2026-11-08T01:00:00.000Z" }));
    expect(next[1]).toMatchObject({ body: "こんにちは", edited: true, reactions: thumbs });
    expect(next[0]).toBe(list[0]);
  });
  it("届いたリアクションで置き換える・知らない ID は何もしない", () => {
    const list = [dm(1, "x")];
    expect(setDmReactions(list, 1, thumbs)[0].reactions).toEqual(thumbs);
    expect(setDmReactions(list, 9, thumbs)).toEqual(list);
  });
});

describe("👥 グループ", () => {
  it("直した発言を差し替える", () => {
    const next = replaceEditedG([gm(5, "10 じ", { reactions: thumbs })], gm(5, "11 時", { edited: true, reactions: [] }));
    expect(next[0]).toMatchObject({ body: "11 時", edited: true, reactions: [] });
  });
  it("リアクションを置き換える", () => {
    expect(setGReactions([gm(5, "x")], 5, thumbs)[0].reactions).toEqual(thumbs);
  });
});
