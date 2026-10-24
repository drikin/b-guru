/**
 * 📺 YouTube 共同鑑賞の配信・アプリ向けの告知（DB なし）:
 *  - liveToStreamEvent: watch は { state }（メールは載らない）
 *  - capabilities: features.watch、無効なら enabled:false、stream.events は有効なときだけ増える
 *  - プレイヤーのページ（public/watch/）が版 1 の受け取り口を持つ
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { agentCapabilities, liveToStreamEvent, WATCH_BRIDGE_VERSION } from "../agent-chat";
import type { WatchStateDto } from "../watch";

const viewer = { userId: "uid_me", mentionNames: new Set<string>() };
const state: WatchStateDto = {
  version: 3,
  video: { video_id: "dQw4w9WgXcQ", title: "t", channel: "c", by: "ねこ" },
  playing: true,
  position: 12.5,
  updated_at: 1_700_000_000_000,
  server_now: 1_700_000_001_000,
  last: { by: "みけ", action: "seek" },
  queue: [{ id: 1, video_id: "9bZkp7q19f0", title: "q", channel: null, by: "ねこ" }],
  youtube_host: "www.youtube.com",
};

describe("📺 共同鑑賞の配信と告知", () => {
  it("watch は { state } そのまま（メールなし）", () => {
    const out = liveToStreamEvent({ type: "watch", state }, viewer);
    expect(out).toEqual({ event: "watch", data: { state } });
    expect(JSON.stringify(out)).not.toMatch(/@/);
  });

  it("capabilities: 有効なときだけ features.watch.enabled と stream の watch", () => {
    const on = agentCapabilities(["read", "chat"], { watch: true });
    expect(on.features.watch).toEqual({
      enabled: true,
      path: "/api/agent/watch",
      player_url: "/watch/index.html",
      bridge_version: WATCH_BRIDGE_VERSION,
      control: true,
    });
    expect(on.features.stream.events).toContain("watch");
    const readOnly = agentCapabilities(["read"], { watch: true });
    expect(readOnly.features.watch.control).toBe(false);
    const off = agentCapabilities(["read", "chat"], {});
    expect(off.features.watch.enabled).toBe(false);
    expect(off.features.stream.events).not.toContain("watch");
  });

  it("プレイヤーのページが版の受け取り口を持つ", () => {
    const js = readFileSync(path.join(process.cwd(), "public/watch/player.js"), "utf8");
    expect(js).toContain(`BRIDGE_VERSION = ${WATCH_BRIDGE_VERSION}`);
    expect(js).toContain("window.bguruWatch");
  });
});
