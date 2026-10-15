/**
 * sendChatMessage（Web とエージェント共通の送信経路）:
 *  - 1 回の DB 往復で INSERT まで終わる
 *  - 同じ (email, clientId) の再送・同時送信は 1 件しか保存しない
 *  - 保存に失敗したら同じ clientId で再送できる
 *  - 配信ペイロードに isAuthor / email を載せない
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { sendChatMessage } from "../chat";
import { liveBus, type LiveEvent } from "../live";

let nextId = 100;
function dbOk() {
  query.mockImplementation(async (sql: unknown) => {
    const s = String(sql);
    if (s.includes("INSERT INTO chat_messages")) {
      nextId += 1;
      return {
        rows: [{ id: nextId, author_email: "me@example.com", author_name: "ドリキン", body: "hi", edited: false, edited_at: null, created_at: new Date(), user_id: "uid_me" }],
      };
    }
    return { rows: [], rowCount: 0 };
  });
}
const inserts = () => query.mock.calls.filter((c) => String(c[0]).includes("INSERT INTO chat_messages")).length;

beforeEach(() => {
  query.mockReset();
});

describe("sendChatMessage", () => {
  it("1 回の INSERT 文で保存し、isAuthor と email を配信しない", async () => {
    dbOk();
    const seen: LiveEvent[] = [];
    const on = (e: LiveEvent) => seen.push(e);
    liveBus.on("change", on);
    const m = await sendChatMessage("me@example.com", "hi", "cid-a");
    liveBus.off("change", on);
    expect(inserts()).toBe(1);
    expect(m).toMatchObject({ isAuthor: true, authorId: "uid_me", clientId: "cid-a" });
    const ev = seen.find((e) => e.type === "chat")!;
    expect(JSON.stringify(ev)).not.toContain("isAuthor");
    expect(JSON.stringify(ev)).not.toContain("me@example.com");
  });

  it("同じ clientId の再送・同時送信は 1 件だけ保存して同じメッセージを返す", async () => {
    dbOk();
    const [a, b] = await Promise.all([
      sendChatMessage("me@example.com", "hi", "cid-b"),
      sendChatMessage("ME@example.com", "hi", "cid-b"),
    ]);
    const c = await sendChatMessage("me@example.com", "hi", "cid-b");
    expect(inserts()).toBe(1);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
  });

  it("別の人の同じ clientId は別扱い・clientId 無しは毎回保存", async () => {
    dbOk();
    await sendChatMessage("me@example.com", "hi", "cid-c");
    await sendChatMessage("you@example.com", "hi", "cid-c");
    await sendChatMessage("me@example.com", "hi", null);
    await sendChatMessage("me@example.com", "hi", null);
    expect(inserts()).toBe(4);
  });

  it("保存に失敗したら同じ clientId で再送できる", async () => {
    query.mockRejectedValueOnce(new Error("db down"));
    await expect(sendChatMessage("me@example.com", "hi", "cid-d")).rejects.toThrow("db down");
    dbOk();
    const m = await sendChatMessage("me@example.com", "hi", "cid-d");
    expect(m.clientId).toBe("cid-d");
    expect(inserts()).toBe(2); // 失敗分 + 再送分
  });

});
