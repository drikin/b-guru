import { describe, it, expect } from "vitest";
import {
  validatePollInput,
  endsAtOf,
  isPollClosed,
  canEditPoll,
  buildPostPoll,
  POLL_EDIT_WINDOW_MS,
} from "../poll";

const T0 = new Date("2026-08-21T00:00:00Z").getTime();

describe("validatePollInput", () => {
  it("3択はOK", () => {
    expect(validatePollInput("来月のゲストは？", ["A", "B", "C"])).toBeNull();
  });
  it("10択はOK", () => {
    const opts = Array.from({ length: 10 }, (_, i) => `選択${i + 1}`);
    expect(validatePollInput("Q", opts)).toBeNull();
  });
  it("2択はNG", () => {
    expect(validatePollInput("Q", ["A", "B"])).toContain("3個以上");
  });
  it("11択はNG", () => {
    const opts = Array.from({ length: 11 }, (_, i) => `x${i}`);
    expect(validatePollInput("Q", opts)).toContain("最大10個");
  });
  it("空質問はNG", () => {
    expect(validatePollInput("   ", ["A", "B", "C"])).toContain("質問");
  });
  it("空白だけの選択肢は無視・実質2択でNG", () => {
    expect(validatePollInput("Q", ["A", "   ", "C"])).toContain("3個以上");
  });
  it("101字の選択肢はNG", () => {
    expect(validatePollInput("Q", ["A", "B", "x".repeat(101)])).toContain("100文字");
  });
  it("不正な締切時間はNG・正しい値はOK", () => {
    expect(validatePollInput("Q", ["A", "B", "C"], 7)).toContain("締切");
    expect(validatePollInput("Q", ["A", "B", "C"], 24)).toBeNull();
    expect(validatePollInput("Q", ["A", "B", "C"], 1)).toBeNull();
  });
});

describe("endsAtOf / isPollClosed", () => {
  it("作成+24h", () => {
    expect(endsAtOf(new Date(T0), 24).getTime()).toBe(T0 + 24 * 3600 * 1000);
  });
  it("締切判定: 締切後は true / 前は false", () => {
    const ends = new Date(T0 + 3600 * 1000);
    expect(isPollClosed(ends, T0)).toBe(false); // 前
    expect(isPollClosed(ends, T0 + 3600 * 1000 + 1)).toBe(true); // 後
  });
});

describe("canEditPoll", () => {
  it("投稿後1時間以内は true / 超過は false", () => {
    expect(canEditPoll(new Date(T0), T0 + POLL_EDIT_WINDOW_MS - 1)).toBe(true);
    expect(canEditPoll(new Date(T0), T0 + POLL_EDIT_WINDOW_MS)).toBe(false);
  });
});

describe("buildPostPoll", () => {
  const base = {
    question: "どれが好き？",
    endsAt: new Date(T0 + 24 * 3600 * 1000),
    createdAt: new Date(T0),
    isAuthor: false,
  };
  it("％は票数比で計算・total0は0", () => {
    const p = buildPostPoll({
      ...base,
      options: [
        { id: 1, label: "A", votes: 1 },
        { id: 2, label: "B", votes: 3 },
      ],
      myVote: null,
      now: T0,
    });
    expect(p.totalVotes).toBe(4);
    expect(p.options[0].pct).toBe(25);
    expect(p.options[1].pct).toBe(75);
    const zero = buildPostPoll({
      ...base,
      options: [
        { id: 1, label: "A", votes: 0 },
        { id: 2, label: "B", votes: 0 },
      ],
      myVote: null,
      now: T0,
    });
    expect(zero.totalVotes).toBe(0);
    expect(zero.options[0].pct).toBe(0);
  });
  it("closed は now 依存", () => {
    const afterEnd = buildPostPoll({
      ...base,
      endsAt: new Date(T0 + 1000),
      options: [{ id: 1, label: "A", votes: 1 }],
      myVote: null,
      now: T0 + 5000,
    });
    expect(afterEnd.closed).toBe(true);
  });
  it("editable は isAuthor かつ1時間以内のみ", () => {
    const asAuthor = (now: number, created: number) =>
      buildPostPoll({
        ...base,
        createdAt: new Date(created),
        options: [{ id: 1, label: "A", votes: 1 }],
        myVote: null,
        isAuthor: true,
        now,
      });
    expect(asAuthor(T0 + 1000, T0).editable).toBe(true);
    expect(asAuthor(T0 + POLL_EDIT_WINDOW_MS, T0).editable).toBe(false);
    // 非 author は時間内でも editable=false
    expect(
      buildPostPoll({
        ...base,
        options: [{ id: 1, label: "A", votes: 1 }],
        myVote: null,
        isAuthor: false,
        now: T0,
      }).editable
    ).toBe(false);
  });
  it("myVote をそのまま返す・voterCount=totalVotes", () => {
    const p = buildPostPoll({
      ...base,
      options: [
        { id: 1, label: "A", votes: 2 },
        { id: 2, label: "B", votes: 1 },
      ],
      myVote: 2,
      isAuthor: true,
      now: T0,
    });
    expect(p.myVote).toBe(2);
    expect(p.voterCount).toBe(3);
  });
});
