/**
 * チャットのリアクションをアプリのストリームへ即時に流す（tochi 2026-10-17「自分の発言でもリアクションが見えるように」）。
 *  - 受け手ごとに mine を付ける（不透明な user_id で判定・メールは載せない）
 *  - チャットのリアクションを付け外ししたら live に流れる（投稿のリアクションでは流さない）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const emitted: unknown[] = [];
vi.mock("../live", () => ({ emitLive: (e: unknown) => emitted.push(e), liveBus: { on: vi.fn(), off: vi.fn() } }));

import { liveToStreamEvent } from "../agent-chat";
import { toggleReaction } from "../reactions";

beforeEach(() => {
  query.mockReset();
  emitted.length = 0;
});

describe("chat_reaction → アプリのストリーム", () => {
  const ev = {
    type: "chat_reaction" as const,
    messageId: 42,
    reactions: [{ emoji: "❤️", count: 2, reactors: ["mazzo", "ドリキン"], userIds: ["u_mazzo", "u_me"] }],
  };

  it("自分が付けたものは mine: true", () => {
    const out = liveToStreamEvent(ev, { userId: "u_me", mentionNames: new Set() });
    expect(out).toEqual({
      event: "chat",
      data: { action: "reactions", id: 42, reactions: [{ emoji: "❤️", count: 2, mine: true, reactors: ["mazzo", "ドリキン"] }] },
    });
  });

  it("他人には mine: false。user_id もメールも出さない", () => {
    const out = liveToStreamEvent(ev, { userId: "u_other", mentionNames: new Set() });
    const text = JSON.stringify(out);
    expect(text).toContain('"mine":false');
    expect(text).not.toContain("u_mazzo");
    expect(text).not.toContain("@");
  });

  it("チャットのリアクションを付けると live に流れる（投稿では流さない）", async () => {
    query.mockImplementation(async (sql: string) => {
      if (String(sql).includes("SELECT r.emoji")) return { rows: [{ emoji: "👍", count: 1, user_ids: ["u_me"], reactors: ["ドリキン"] }] };
      return { rows: [], rowCount: 0 };
    });
    await toggleReaction("chat", 7, "me@example.com", "👍");
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual([{ type: "chat_reaction", messageId: 7, reactions: [{ emoji: "👍", count: 1, reactors: ["ドリキン"], userIds: ["u_me"] }] }]);
    emitted.length = 0;
    await toggleReaction("post", 7, "me@example.com", "👍");
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toEqual([]);
  });
});
