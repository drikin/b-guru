/**
 * ☗ 将棋の配信・アプリ向けの形（DB なし）:
 *  - liveToStreamEvent: shogi イベントは { action, game } でそのまま。ネイティブ向けの既存イベントの形は変わらない
 *  - チャットの対局中カード: DTO は kind "shogi" と shogi_game_id（古いアプリは普通の発言として出す）
 *  - capabilities: features.shogi、無効なら enabled:false、stream.events / push.kinds は有効なときだけ増える
 *  - SHOGI_ENABLED の読み方、通知の中身（ids だけ）
 *  - 盤の WebView 用の束（public/shogi-board/board.js）が今のソースから作られている
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentCapabilities, liveToStreamEvent, toAgentChatDto } from "../agent-chat";
import type { LiveEvent } from "../live";
import { shogiEnabledFor } from "../shogi";
import { buildPushPayload } from "../push-notify";
import { toBoardState } from "../shogi-board/bridge";
import type { ShogiGameDto } from "../shogi-types";

const viewer = { userId: "uid_me", mentionNames: new Set<string>() };

const game: ShogiGameDto = {
  id: 12,
  status: "active",
  mode: "blitz",
  creator: { user_id: "u1", name: "A", avatar: null },
  invitee: null,
  black: { user_id: "u1", name: "A", avatar: null },
  white: { user_id: "u2", name: "B", avatar: null },
  sfen: "lnsgkgsnl/1r5b1/ppppppppp/9/9/2P6/PP1PPPPPP/1B5R1/LNSGKGSNL w - 2",
  ply: 1,
  turn: "white",
  last_move: { usi: "7g7f", label: "▲7六歩" },
  clocks: { black_ms: 600000, white_ms: 600000, byoyomi_ms: 30000, initial_ms: 600000 },
  turn_started_at: "2026-10-21T12:00:00.000Z",
  deadline_at: "2026-10-21T12:01:01.000Z",
  server_now: "2026-10-21T12:00:01.000Z",
  spectators: 3,
  result: null,
  end_reason: null,
  created_at: "2026-10-21T11:59:00.000Z",
  started_at: "2026-10-21T12:00:00.000Z",
  ended_at: null,
  rematch_of: null,
  card_message_id: 99,
  result_post_id: null,
};

describe("配信の形", () => {
  it("shogi は { action, game } で配る", () => {
    expect(liveToStreamEvent({ type: "shogi", action: "state", game }, viewer)).toEqual({
      event: "shogi",
      data: { action: "state", game },
    });
    expect(liveToStreamEvent({ type: "shogi", action: "end", game }, viewer)?.data.action).toBe("end");
  });

  it("ネイティブ向けの既存イベントの形は変わらない", () => {
    const cases: [LiveEvent, unknown][] = [
      [{ type: "presence", userIds: ["a"] }, { event: "presence", data: { user_ids: ["a"] } }],
      [{ type: "post", postId: 5, action: "create" }, { event: "post", data: { action: "create", post_id: 5 } }],
      [{ type: "post", postId: 5, action: "update" }, null],
      [{ type: "chat", action: "delete", message: { id: 3 } }, { event: "chat", data: { action: "delete", id: 3 } }],
      [{ type: "pin", postId: 1, action: "toggle" }, null],
      [{ type: "club", postId: 1, club: null }, null],
      [
        { type: "chat_reaction", messageId: 3, reactions: [{ emoji: "👍", count: 1, reactors: ["A"], userIds: ["uid_me"] }] },
        { event: "chat", data: { action: "reactions", id: 3, reactions: [{ emoji: "👍", count: 1, mine: true, reactors: ["A"] }] } },
      ],
    ];
    for (const [ev, want] of cases) expect(liveToStreamEvent(ev, viewer)).toEqual(want);
    // 普通の発言・お知らせの DTO にも shogi の項目は付かない
    const plain = toAgentChatDto({ id: 1, authorId: "x", body: "hi", createdAt: "t" }, viewer);
    expect(plain).not.toHaveProperty("kind");
    expect(plain).not.toHaveProperty("shogi_game_id");
    expect(toAgentChatDto({ id: 2, body: "入室", kind: "notice" }, viewer).kind).toBe("notice");
  });

  it("対局中カードは kind shogi と shogi_game_id（本文はそのまま読める文）", () => {
    const dto = toAgentChatDto({ id: 7, authorId: "sys", authorName: "B-guru", body: "☗A vs ☖B（⚡速い将棋）対局中", kind: "shogi", shogiGameId: 12 }, viewer);
    expect(dto).toMatchObject({ kind: "shogi", shogi_game_id: 12, body: "☗A vs ☖B（⚡速い将棋）対局中", is_author: false });
  });
});

describe("capabilities", () => {
  it("有効: features.shogi と stream / push に shogi", () => {
    const c = agentCapabilities(["read", "chat"], { shogi: true });
    expect(c.features.shogi).toMatchObject({
      enabled: true,
      path: "/api/agent/shogi",
      board_url: "/shogi-board/index.html",
      bridge_version: 1,
      play: true,
      beagle: true,
    });
    expect(c.features.shogi.time_controls.map((t) => t.mode)).toEqual(["blitz", "slow"]);
    expect(c.features.stream.events).toContain("shogi");
    expect(c.features.push.kinds).toEqual(["chat_mention", "chat_new", "reply", "shogi_offer", "shogi_turn"]);
  });
  it("無効: enabled:false、ほかは今までどおり", () => {
    const c = agentCapabilities(["read"], {});
    expect(c.features.shogi.enabled).toBe(false);
    expect(c.features.stream.events).toEqual(["ready", "chat", "presence", "notification", "voice"]);
    expect(c.features.push.kinds).toEqual(["chat_mention", "chat_new", "reply"]);
  });
});

describe("SHOGI_ENABLED", () => {
  const old = process.env.SHOGI_ENABLED;
  afterEach(() => {
    if (old === undefined) delete process.env.SHOGI_ENABLED;
    else process.env.SHOGI_ENABLED = old;
  });
  it("未設定は誰にも出さない、1 で全員、メールのカンマ区切りはその人だけ", () => {
    delete process.env.SHOGI_ENABLED;
    expect(shogiEnabledFor("a@x.jp")).toBe(false);
    process.env.SHOGI_ENABLED = "0";
    expect(shogiEnabledFor("a@x.jp")).toBe(false);
    process.env.SHOGI_ENABLED = "1";
    expect(shogiEnabledFor("a@x.jp")).toBe(true);
    expect(shogiEnabledFor(null)).toBe(false);
    process.env.SHOGI_ENABLED = "A@x.jp, b@y.jp";
    expect(shogiEnabledFor("a@x.jp")).toBe(true);
    expect(shogiEnabledFor("c@z.jp")).toBe(false);
  });
});

describe("通知", () => {
  it("ids だけ（盤面や名前は載せない）、対局ごとに thread", () => {
    const p = buildPushPayload("shogi_turn", { gameId: 12 });
    expect(p).toMatchObject({ kind: "shogi_turn", game_id: 12, aps: { "thread-id": "shogi-12" } });
    expect(JSON.stringify(p)).not.toMatch(/sfen|name/);
  });
});

describe("盤の WebView 用の束", () => {
  it("public/shogi-board/board.js は今のソースから作られている（違えば node scripts/build-shogi-board.mjs）", async () => {
    const { sourceHash } = await import("../../../scripts/build-shogi-board.mjs");
    const js = readFileSync(path.join(process.cwd(), "public/shogi-board/board.js"), "utf8");
    expect(js.slice(0, 300)).toContain(`source:${sourceHash()}`);
  });

  it("橋渡し: アプリからの state を検証して盤の状態にする（不正な値は捨てる）", () => {
    const prev = { sfen: "x", myColor: null, canMove: false };
    const s = toBoardState(
      {
        type: "state",
        sfen: game.sfen,
        my_color: "white",
        can_move: true,
        last_move: { usi: "7g7f", label: "▲7六歩" },
        settings: { confirm_move: true, move_hints: false },
        theme: "dark",
        legal_moves: ["3c3d", 5],
        token: "secret",
      },
      prev
    );
    expect(s).toMatchObject({
      sfen: game.sfen,
      myColor: "white",
      canMove: true,
      lastMove: { usi: "7g7f", label: "▲7六歩" },
      settings: { confirmMove: true, moveHints: false },
      theme: "dark",
      legalMoves: ["3c3d"],
    });
    expect(JSON.stringify(s)).not.toContain("secret");
    const bad = toBoardState({ type: "state", my_color: "red", can_move: "yes", theme: "neon" }, prev);
    expect(bad).toMatchObject({ myColor: null, canMove: false, theme: "auto", sfen: "x" });
  });
});
