/** The club room (lib/room.ts, lib/room-map.ts): map, voice rule, coming and going,
 *  walking, speaker limits, reactions — and no email ever leaves in an event. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const query = vi.fn(async (..._a: unknown[]) => ({ rows: [] as unknown[] }));
vi.mock("@/lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
const events: unknown[] = [];
vi.mock("@/lib/live", () => ({ emitLive: (e: unknown) => events.push(e) }));
vi.mock("@/lib/display-name", () => ({ resolveDisplayNames: async (emails: string[]) => new Map(emails.map((e) => [e, e.split("@")[0].toUpperCase()])) }));
vi.mock("@/lib/user", () => ({ ensureUserId: async (e: string) => `uid_${e.split("@")[0]}` }));
vi.mock("@/lib/livekit", () => ({ livekitConfig: () => ({}) }));
let inVoice: string[] = [];
vi.mock("@/lib/voice", () => ({ getVoiceState: async () => ({ participants: inVoice.map((userId) => ({ userId })) }) }));

import { ROOM_DOOR, ROOM_SEATS, ROOM_TILES, ROOM_W, ROOM_H, ROOM_ZONES, audibility, walkable, zoneAt } from "../room-map";
import {
  RING_MAX_SPEAKERS, STAGE_MAX_SPEAKERS, __resetRoomForTests, roomConnect, roomDisconnect, roomEnter, roomMove,
  roomReact, roomSnapshot, roomToText, roomVoice, sweepRoom,
} from "../room";

const me = "me@example.com";
const who = (email: string) => roomSnapshot().find((m) => m.userId === `uid_${email.split("@")[0]}`)!;
/** Enter the room and walk someone to a spot (optionally with the mic on). */
async function placeAt(email: string, x: number, y: number, mic = false) {
  await roomConnect(email);
  await roomEnter(email);
  const m = who(email);
  // walk there one tile at a time, x first then y (paths in these tests are clear)
  let cx = m.x, cy = m.y;
  for (let guard = 0; (cx !== x || cy !== y) && guard < 200; guard++) {
    const nx = cx + Math.sign(x - cx), ny = cx !== x ? cy : cy + Math.sign(y - cy);
    const tx = cx !== x ? nx : cx;
    vi.advanceTimersByTime(200);
    const res = roomMove(email, tx, ny);
    if (!res.ok) throw new Error(`${email} cannot reach ${x},${y}: ${res.error} at ${tx},${ny}`);
    cx = tx; cy = ny;
  }
  if (mic) { vi.advanceTimersByTime(200); const v = roomVoice(email, { mic: true }); if (!v.ok) throw new Error(v.error); }
}

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ROOM_ALLOW_EMAILS = "*";
  __resetRoomForTests();
  events.length = 0;
  query.mockClear();
  inVoice = [];
});
afterEach(() => vi.useRealTimers());

describe("room map", () => {
  it("is the stated size, walled, with a reachable door spot and 24 chat seats", () => {
    expect(ROOM_TILES).toHaveLength(ROOM_H);
    ROOM_TILES.forEach((r) => expect(r).toHaveLength(ROOM_W));
    expect(walkable(0, 0)).toBe(false);
    expect(walkable(ROOM_DOOR.x, ROOM_DOOR.y)).toBe(true);
    expect(ROOM_SEATS).toHaveLength(24);
    ROOM_SEATS.forEach((s) => expect(walkable(s.x, s.y)).toBe(true));
    expect(zoneAt(5, 11)?.kind).toBe("table");
    expect(zoneAt(25, 3)?.kind).toBe("stage");
    expect(ROOM_ZONES.map((z) => z.kind).sort()).toEqual(["stage", "table"]);
  });

  it("voice: near is louder, far is silent, the table is private, the stage reaches everyone", () => {
    const at = (x: number, y: number) => ({ x, y });
    expect(audibility(at(15, 8), at(16, 8))).toBe(1);
    expect(audibility(at(15, 8), at(18, 8))).toBeGreaterThan(0);
    expect(audibility(at(15, 8), at(18, 8))).toBeLessThan(1);
    expect(audibility(at(15, 8), at(25, 8))).toBe(0);
    expect(audibility(at(5, 11), at(9, 14))).toBe(1); // both at the table
    expect(audibility(at(13, 12), at(10, 12))).toBe(0); // next to the table, outside
    expect(audibility(at(10, 12), at(13, 12))).toBe(0);
    expect(audibility(at(2, 18), at(25, 3))).toBe(1); // the stage
    expect(audibility(at(5, 11), at(25, 3))).toBe(1); // even at the table
  });
});

describe("coming and going", () => {
  it("a connection puts you at a chat seat in text view; entering walks you in from the door", async () => {
    await roomConnect(me);
    expect(who(me)).toMatchObject({ mode: "text", listening: false, mic: false });
    expect(ROOM_SEATS).toContainEqual({ x: who(me).x, y: who(me).y });
    const r = await roomEnter(me);
    expect(r.ok && r.from).toEqual(ROOM_DOOR);
    expect(who(me)).toMatchObject({ mode: "room", listening: true, mic: false });
    expect(walkable(who(me).x, who(me).y)).toBe(true);
  });

  it("back to text: out of the voice, mic off, at a seat, last position saved", async () => {
    await placeAt(me, 15, 12, true);
    vi.advanceTimersByTime(200);
    roomToText(me);
    expect(who(me)).toMatchObject({ mode: "text", listening: false, mic: false });
    expect(query.mock.calls.some((c) => String(c[0]).includes("room_positions"))).toBe(true);
  });

  it("closing the last connection removes you after the grace period, unless you reconnect", async () => {
    await roomConnect(me);
    roomDisconnect(me);
    vi.advanceTimersByTime(20_000);
    await roomConnect(me);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(roomSnapshot()).toHaveLength(1);
    roomDisconnect(me);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(roomSnapshot()).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "room", action: "leave" });
  });

  it("an app in the background stays while it is in the voice (the call goes on)", async () => {
    await placeAt(me, 15, 12);
    inVoice = ["uid_me"];
    roomDisconnect(me);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(roomSnapshot()).toHaveLength(1);
    inVoice = [];
    await vi.advanceTimersByTimeAsync(31_000);
    expect(roomSnapshot()).toHaveLength(0);
  });
});

describe("walking", () => {
  it("refuses walls, jumps, other people's tiles and floods", async () => {
    await placeAt(me, 15, 12);
    vi.advanceTimersByTime(200);
    expect(roomMove(me, 0, 0).ok).toBe(false); // wall
    expect(roomMove(me, 15, 15).ok).toBe(false); // 3 tiles away
    await placeAt("ryu@example.com", 16, 12);
    vi.advanceTimersByTime(200);
    expect(roomMove(me, 16, 12).ok).toBe(false); // occupied
    vi.advanceTimersByTime(1000);
    let refused = 0;
    for (let i = 0; i < 20; i++) if (!roomMove(me, i % 2 ? 15 : 15, i % 2 ? 12 : 11).ok) refused++;
    expect(refused).toBeGreaterThan(0); // more than 12 a second
  });
});

describe("speaker limits", () => {
  it("at most STAGE_MAX_SPEAKERS on the stage", async () => {
    const spots = [[24, 3], [25, 3], [27, 3], [28, 3]];
    for (let i = 0; i < STAGE_MAX_SPEAKERS; i++) await placeAt(`s${i}@example.com`, spots[i][0], spots[i][1], true);
    await placeAt("late@example.com", spots[3][0], spots[3][1]);
    vi.advanceTimersByTime(200);
    const r = roomVoice("late@example.com", { mic: true });
    expect(r.ok).toBe(false);
  });

  it("nobody hears more than RING_MAX_SPEAKERS at once", async () => {
    // a crowd around the lounge, everyone talking
    const spots: [number, number][] = [];
    for (let y = 11; y <= 13; y++) for (let x = 14; x <= 17; x++) spots.push([x, y]);
    let ok = 0, refused = 0;
    for (let i = 0; i < spots.length; i++) {
      await placeAt(`p${i}@example.com`, spots[i][0], spots[i][1]);
      vi.advanceTimersByTime(200);
      roomVoice(`p${i}@example.com`, { mic: true }).ok ? ok++ : refused++;
    }
    expect(ok).toBeLessThanOrEqual(RING_MAX_SPEAKERS + 1);
    expect(refused).toBeGreaterThan(0);
  });

  it("見るだけ cannot turn the mic on, and leaving the voice turns it off", async () => {
    await placeAt(me, 15, 12, true);
    vi.advanceTimersByTime(200);
    roomVoice(me, { listening: false });
    expect(who(me)).toMatchObject({ listening: false, mic: false });
    vi.advanceTimersByTime(200);
    expect(roomVoice(me, { mic: true }).ok).toBe(false);
  });
});

describe("reactions, idle, privacy", () => {
  it("only the set emoji; a wave can name someone in the house", async () => {
    await placeAt(me, 15, 12);
    vi.advanceTimersByTime(200);
    expect(roomReact(me, "🍻").ok).toBe(true);
    vi.advanceTimersByTime(200);
    expect(roomReact(me, "💩").ok).toBe(false);
    await roomConnect("ryu@example.com");
    vi.advanceTimersByTime(200);
    roomReact(me, "👋", "uid_ryu");
    expect(events.at(-1)).toMatchObject({ type: "room", action: "react", emoji: "👋", to: "uid_ryu" });
  });

  it("💤 after 10 minutes, mic off after 30", async () => {
    await placeAt(me, 15, 12, true);
    sweepRoom(Date.now() + 11 * 60_000);
    expect(who(me)).toMatchObject({ away: true, mic: true });
    sweepRoom(Date.now() + 31 * 60_000);
    expect(who(me)).toMatchObject({ mic: false });
  });

  it("events carry user ids and names, never an email", async () => {
    await placeAt(me, 15, 12, true);
    vi.advanceTimersByTime(200);
    roomReact(me, "👏");
    expect(JSON.stringify(events)).not.toContain("@");
  });
});
