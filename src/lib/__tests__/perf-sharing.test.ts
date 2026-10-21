/** Shared server caches and client-side coalescing (performance round 2, 2026-10-20):
 *  clubs/counts + hot shared by everyone, presence list carried in the SSE event,
 *  jukebox list built once with an ETag. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const bus = vi.hoisted(() => ({ emitter: null as null | import("events").EventEmitter }));
vi.mock("../live", async () => {
  const { EventEmitter } = await import("events");
  bus.emitter = new EventEmitter();
  return { liveBus: bus.emitter, emitLive: (e: unknown) => bus.emitter!.emit("change", e) };
});

import { sharedCache, invalidateOnPostChange } from "../shared-cache";
import { createDeferredRefresh } from "../deferred-refresh";
import { liveToStreamEvent } from "../agent-chat";

describe("sharedCache", () => {
  it("shares one load within the TTL and coalesces concurrent loads", async () => {
    let t = 0;
    const load = vi.fn(async () => ++t);
    const c = sharedCache(1000, load, () => now);
    let now = 0;
    const [a, b] = await Promise.all([c.get(), c.get()]);
    expect([a, b]).toEqual([1, 1]);
    expect(await c.get()).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    now = 1000;
    expect(await c.get()).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not keep a result that was loading when it was invalidated", async () => {
    let release!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (release = r)));
    const c = sharedCache(60_000, load);
    const first = c.get();
    c.invalidate();
    release("old");
    expect(await first).toBe("old");
    const second = c.get(); // must load again, not reuse "old"
    release("new");
    expect(await second).toBe("new");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("is thrown away on post create/delete and club changes, not on update", async () => {
    let n = 0;
    const c = invalidateOnPostChange(sharedCache(60_000, async () => ++n));
    expect(await c.get()).toBe(1);
    bus.emitter!.emit("change", { type: "post", postId: 1, action: "update" });
    expect(await c.get()).toBe(1);
    bus.emitter!.emit("change", { type: "post", postId: 1, action: "create" });
    expect(await c.get()).toBe(2);
    bus.emitter!.emit("change", { type: "club", postId: 1, club: "x" });
    expect(await c.get()).toBe(3);
    bus.emitter!.emit("change", { type: "post", postId: 1, action: "delete" });
    expect(await c.get()).toBe(4);
  });
});

describe("createDeferredRefresh (client)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs a burst of the same refresh once, after the delay", () => {
    const hot = vi.fn();
    const counts = vi.fn();
    const d = createDeferredRefresh(3000, () => false);
    for (let i = 0; i < 10; i++) {
      d.schedule("hot", hot);
      d.schedule("counts", counts);
    }
    expect(hot).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3000);
    expect(hot).toHaveBeenCalledTimes(1);
    expect(counts).toHaveBeenCalledTimes(1);
  });

  it("holds work while the tab is hidden and runs it once when it comes back", () => {
    let hidden = true;
    const hot = vi.fn();
    const d = createDeferredRefresh(3000, () => hidden);
    d.schedule("hot", hot);
    d.schedule("hot", hot);
    vi.advanceTimersByTime(10_000);
    expect(hot).not.toHaveBeenCalled();
    d.flushIfVisible(); // still hidden
    expect(hot).not.toHaveBeenCalled();
    hidden = false;
    d.flushIfVisible();
    expect(hot).toHaveBeenCalledTimes(1);
    d.flushIfVisible();
    expect(hot).toHaveBeenCalledTimes(1);
  });

  it("dispose drops pending work", () => {
    const hot = vi.fn();
    const d = createDeferredRefresh(3000, () => false);
    d.schedule("hot", hot);
    d.dispose();
    vi.advanceTimersByTime(5000);
    expect(hot).not.toHaveBeenCalled();
  });
});

describe("presence event for the native apps stays user_ids only", () => {
  it("drops the Web-only members list", () => {
    const viewer = { email: "v@example.com", userId: "uv", mentionNames: [] } as unknown as Parameters<typeof liveToStreamEvent>[1];
    const out = liveToStreamEvent(
      { type: "presence", userIds: ["u1"], members: [{ userId: "u1", name: "n", avatar: "/api/avatar/x", visible: true }] },
      viewer
    );
    expect(out).toEqual({ event: "presence", data: { user_ids: ["u1"] } });
  });
});

