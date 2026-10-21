/**
 * 🎮 締め切りダッシュの配信・アプリ向けの形・束（DB なし）:
 *  - liveToStreamEvent: minigame は { action, period, key, top }。ネイティブ向けの既存イベントの形は変わらない
 *  - capabilities: features.minigame、無効なら enabled:false、stream.events は有効なときだけ増える
 *  - MINIGAME_ENABLED の読み方（featureEnabledFor。SHOGI_ENABLED も同じ読み方のまま）
 *  - 日付（今日のチャレンジは JST 5 時区切り、週は JST 月曜区切り）・順位表の名前・チャットの 1 行と週の王者の文
 *  - 束: public/minigame/game.js と検算 worker の文字列が今のソースから作られている、worker の再生がその場の再生と同じ
 *  - ドット絵: ゲームが使う名前がすべてある（足りなければ仮の絵で埋まる）
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentCapabilities, liveToStreamEvent, toAgentChatDto } from "../agent-chat";
import type { LiveEvent } from "../live";
import { featureEnabledFor, featurePublic } from "../feature-flag";
import { shogiEnabledFor } from "../shogi";
import {
  announceText,
  boardFor,
  boardsFor,
  dailyDate,
  dailyResetsAt,
  minigameEnabledFor,
  minigamePublic,
  weekStart,
  weeklyText,
} from "../minigame";
import { infoFromState } from "../minigame/bridge";
import { NEEDED, SPRITE_SET } from "../minigame/sprites";
import { ENGINE_VERSION, replay } from "../minigame/sim";
import { verifyReplay, _stopVerifyWorker } from "../minigame-verify";
import { MINIGAME_WORKER_SOURCE_HASH } from "../minigame-sim-worker.generated";
import type { LeaderEntry } from "../minigame/types";
import { botRun } from "./minigame-bot";

const viewer = { userId: "uid_me", mentionNames: new Set<string>() };
const entry = (rank: number, name: string, score: number): LeaderEntry => ({
  rank,
  user_id: `u${rank}`,
  name,
  avatar: null,
  score,
  distance: score - 100,
  character: "drikin",
  achieved_at: "2026-10-21T01:00:00.000Z",
});

describe("配信の形", () => {
  it("minigame は { action, period, key, top }（メールは載らない）", () => {
    const top = [entry(1, "ぜんじ", 2980), entry(2, "まつお", 2400)];
    const out = liveToStreamEvent({ type: "minigame", action: "leaderboard", period: "today", key: "2026-10-21", top }, viewer);
    expect(out).toEqual({ event: "minigame", data: { action: "leaderboard", period: "today", key: "2026-10-21", top } });
    expect(JSON.stringify(out)).not.toMatch(/@/);
  });

  it("ネイティブ向けの既存イベントの形は変わらない", () => {
    const cases: [LiveEvent, unknown][] = [
      [{ type: "presence", userIds: ["a"] }, { event: "presence", data: { user_ids: ["a"] } }],
      [{ type: "post", postId: 5, action: "create" }, { event: "post", data: { action: "create", post_id: 5 } }],
      [{ type: "post", postId: 5, action: "update" }, null],
      [{ type: "chat", action: "delete", message: { id: 3 } }, { event: "chat", data: { action: "delete", id: 3 } }],
      [{ type: "pin", postId: 1, action: "toggle" }, null],
      [{ type: "club", postId: 1, club: null }, null],
    ];
    for (const [ev, want] of cases) expect(liveToStreamEvent(ev, viewer)).toEqual(want);
    const plain = toAgentChatDto({ id: 1, authorId: "x", body: "hi", createdAt: "t" }, viewer);
    expect(plain).not.toHaveProperty("kind");
    // チャットへの 1 行は今までのお知らせ（kind notice）と同じ形
    expect(toAgentChatDto({ id: 2, body: "🐶 ねこさんが今日の 1 位に！", kind: "notice" }, viewer).kind).toBe("notice");
  });
});

describe("capabilities", () => {
  it("有効: features.minigame と stream に minigame", () => {
    const c = agentCapabilities(["read", "chat"], { minigame: true });
    expect(c.features.minigame).toEqual({
      enabled: true,
      path: "/api/agent/minigame",
      game_url: "/minigame/index.html",
      bridge_version: 1,
      engine_version: ENGINE_VERSION,
      play: true,
      characters: ["drikin", "matsuo", "zenji"],
      modes: ["daily", "free"],
    });
    expect(c.features.stream.events).toContain("minigame");
  });
  it("read だけのトークンは遊べない（play:false）", () => {
    expect(agentCapabilities(["read"], { minigame: true }).features.minigame.play).toBe(false);
  });
  it("無効: enabled:false、stream.events は今までどおり", () => {
    const c = agentCapabilities(["read"], {});
    expect(c.features.minigame.enabled).toBe(false);
    expect(c.features.stream.events).toEqual(["ready", "chat", "presence", "notification", "voice"]);
    expect(agentCapabilities(["read"], { shogi: true }).features.stream.events).toEqual(["ready", "chat", "presence", "notification", "voice", "shogi"]);
  });
});

describe("MINIGAME_ENABLED（featureEnabledFor）", () => {
  const old = { m: process.env.MINIGAME_ENABLED, s: process.env.SHOGI_ENABLED };
  afterEach(() => {
    if (old.m === undefined) delete process.env.MINIGAME_ENABLED;
    else process.env.MINIGAME_ENABLED = old.m;
    if (old.s === undefined) delete process.env.SHOGI_ENABLED;
    else process.env.SHOGI_ENABLED = old.s;
  });
  it("未設定・0 は誰にも出さない、1 で全員（公開）、メールのカンマ区切りはその人だけ（公開ではない）", () => {
    delete process.env.MINIGAME_ENABLED;
    expect(minigameEnabledFor("a@x.jp")).toBe(false);
    expect(minigamePublic()).toBe(false);
    process.env.MINIGAME_ENABLED = "0";
    expect(minigameEnabledFor("a@x.jp")).toBe(false);
    process.env.MINIGAME_ENABLED = "1";
    expect(minigameEnabledFor("a@x.jp")).toBe(true);
    expect(minigameEnabledFor(null)).toBe(false);
    expect(minigamePublic()).toBe(true);
    process.env.MINIGAME_ENABLED = "A@x.jp, b@y.jp";
    expect(minigameEnabledFor("a@x.jp")).toBe(true);
    expect(minigameEnabledFor("c@z.jp")).toBe(false);
    expect(minigamePublic()).toBe(false);
  });
  it("将棋とは別のフラグ・同じ読み方", () => {
    process.env.MINIGAME_ENABLED = "1";
    delete process.env.SHOGI_ENABLED;
    expect(shogiEnabledFor("a@x.jp")).toBe(false);
    process.env.SHOGI_ENABLED = "*";
    expect(shogiEnabledFor("a@x.jp")).toBe(true);
    expect(featurePublic("SHOGI_ENABLED")).toBe(true);
    process.env.SHOGI_ENABLED = "TRUE";
    expect(featureEnabledFor("SHOGI_ENABLED", "a@x.jp")).toBe(true);
  });
});

describe("日付と順位表", () => {
  const jst = (s: string) => Date.parse(`${s}+09:00`);
  it("今日のチャレンジは JST 5 時に替わる", () => {
    expect(dailyDate(jst("2026-10-21T04:59:59"))).toBe("2026-10-20");
    expect(dailyDate(jst("2026-10-21T05:00:00"))).toBe("2026-10-21");
    expect(dailyDate(jst("2026-10-22T00:30:00"))).toBe("2026-10-21");
    expect(dailyResetsAt("2026-10-21")).toBe(new Date(jst("2026-10-22T05:00:00")).toISOString());
  });
  it("週は JST 月曜 0 時区切り", () => {
    // 2026-10-19 は月曜
    expect(weekStart(jst("2026-10-19T00:00:00"))).toBe("2026-10-19");
    expect(weekStart(jst("2026-10-18T23:59:59"))).toBe("2026-10-12");
    expect(weekStart(jst("2026-10-25T23:59:59"))).toBe("2026-10-19");
  });
  it("1 回の記録が載る順位表（先頭がその遊び方の順位表）", () => {
    expect(boardsFor("daily", "2026-10-21", jst("2026-10-22T01:00:00"))).toEqual(["d:2026-10-21", "all", "all:daily"]);
    expect(boardsFor("free", null, jst("2026-10-21T12:00:00"))).toEqual(["w:2026-10-19", "all", "all:free"]);
    expect(boardFor("today", null, jst("2026-10-21T12:00:00"))).toBe("d:2026-10-21");
    expect(boardFor("week", null, jst("2026-10-21T12:00:00"))).toBe("w:2026-10-19");
    expect(boardFor("all", "free")).toBe("all:free");
    expect(boardFor("all", null)).toBe("all");
  });
  it("チャットの 1 行・週の王者の文", () => {
    expect(announceText("leader", "まつお", 2980, 2100, 1)).toBe("🐶 まつおさんが「締め切りダッシュ」今日の 1 位に！ 2,980 点（2,100m）");
    expect(announceText("top5", "ねこ", 1500, 1200, 4)).toContain("今日の 4 位");
    const t = weeklyText([entry(1, "ぜんじ", 12000), entry(2, "まつお", 9000), entry(3, "ねこ", 100)]);
    expect(t.split("\n")[0]).toBe("🏆 先週の「締め切りダッシュ」王者は ぜんじさん！ 12,000 点（11,900m）");
    expect(t).toContain("2 位 まつおさん 9,000 点");
  });
});

describe("橋渡し", () => {
  it("state の中の情報（GET me と同じ形）だけを取り出す", () => {
    const info = infoFromState({ type: "state", engine_version: 1, me: { user_id: "u", name: "n" }, theme: "dark", play: { req: 1 }, plays_today: 3 });
    expect(info).toEqual({ engine_version: 1, me: { user_id: "u", name: "n" }, plays_today: 3 });
  });
});

describe("束", () => {
  it("public/minigame/game.js は今のソースから作られている（違えば node scripts/build-minigame.mjs）", async () => {
    const { gameSourceHash } = await import("../../../scripts/build-minigame.mjs");
    const js = readFileSync(path.join(process.cwd(), "public/minigame/game.js"), "utf8");
    expect(js.slice(0, 300)).toContain(`source:${gameSourceHash()}`);
  });
  it("検算 worker の文字列は今のソースから作られている", async () => {
    const { workerSourceHash } = await import("../../../scripts/build-minigame.mjs");
    expect(MINIGAME_WORKER_SOURCE_HASH).toBe(workerSourceHash());
  });
  it("index.html は game.js だけを読み、ネットワークに出ない", () => {
    const html = readFileSync(path.join(process.cwd(), "public/minigame/index.html"), "utf8");
    expect([...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1])).toEqual(["/minigame/game.js"]);
    expect(html).not.toMatch(/token|fetch\(/i);
  });
  it("worker（別スレッド）の再生はその場の再生と同じ", async () => {
    const r = botRun(31, "matsuo", { lapse: 150, rngSeed: 9 });
    const inThread = await verifyReplay(31, "matsuo", r.inputs, { inline: false });
    expect(inThread).toEqual(replay(31, "matsuo", r.inputs));
    // 壊れた記録も同じ答え
    expect(await verifyReplay(31, "matsuo", "x", { inline: false })).toEqual(replay(31, "matsuo", "x"));
    await _stopVerifyWorker();
  });
});

describe("フラグで閉じる", () => {
  it("Web・アプリの API は MINIGAME_ENABLED で出していない人に 404、配信も落とす", () => {
    const read = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
    for (const f of ["src/app/api/minigame/[...path]/route.ts", "src/app/api/agent/minigame/[...path]/route.ts"]) {
      const src = read(f);
      expect(src.indexOf("minigameEnabledFor(")).toBeGreaterThan(0);
      expect(src.indexOf("minigameEnabledFor(")).toBeLessThan(src.indexOf("handleMinigame("));
    }
    expect(read("src/app/api/agent/stream/route.ts")).toMatch(/ev\.type === "minigame" && !minigameOn\) return/);
    expect(read("src/app/api/posts/stream/route.ts")).toMatch(/event\.type === "minigame" && !minigameOn\) return/);
    expect(read("src/app/api/agent/minigame/[...path]/route.ts")).toMatch(/rateBucket: "minigame"/);
  });
});

describe("ドット絵", () => {
  it("ゲームが使う名前・コマがすべてある", () => {
    for (const [name, frames] of Object.entries(NEEDED)) {
      const sp = SPRITE_SET[name];
      expect(sp, name).toBeTruthy();
      for (const f of frames) expect(sp.frames[f], `${name}/${f}`).toBeTruthy();
      for (const rows of Object.values(sp.frames)) {
        for (const row of rows) for (const ch of row) if (ch !== ".") expect(sp.palette[parseInt(ch, 36)], `${name} ${ch}`).toBeTruthy();
      }
    }
  });
});
