import { describe, expect, it } from "vitest";
import { ROOM_TILES, ROOM_DOOR, ROOM_SEATS, roomMapDto } from "../room-map";
import {
  shortRoomName,
  nextRoomScale,
  roomFitZoom,
  roomZoom,
  DIRS,
  allowedListeners,
  bfsPath,
  bubbleText,
  isWalkable,
  lookFor,
  nearestFreeNeighbor,
  sameIds,
  statusMark,
  volumeFor,
  volumesFor,
  voiceCounts,
  type Dir,
  type RoomMember,
} from "../room-logic";

const m = (userId: string, x: number, y: number, extra: Partial<RoomMember> = {}): RoomMember => ({
  userId,
  name: userId,
  avatar: "",
  x,
  y,
  mode: "room",
  listening: true,
  mic: false,
  away: false,
  ...extra,
});

function walk(from: { x: number; y: number }, path: Dir[]) {
  let { x, y } = from;
  for (const d of path) {
    x += DIRS[d][0];
    y += DIRS[d][1];
    expect(isWalkable(ROOM_TILES, x, y)).toBe(true);
  }
  return { x, y };
}

describe("bfsPath", () => {
  it("walks from the door into the room over walkable tiles only", () => {
    const from = { x: ROOM_DOOR.x, y: ROOM_DOOR.y };
    const to = { x: 20, y: 8 };
    const p = bfsPath(ROOM_TILES, from, to);
    expect(p.length).toBe(Math.abs(to.x - from.x) + Math.abs(to.y - from.y));
    expect(walk(from, p)).toEqual(to);
  });

  it("goes around furniture (the meeting table)", () => {
    const from = { x: 6, y: 11 }; // chair above the table
    const to = { x: 6, y: 14 }; // chair below it
    const p = bfsPath(ROOM_TILES, from, to);
    expect(p.length).toBeGreaterThan(3);
    expect(walk(from, p)).toEqual(to);
  });

  it("returns nothing for a solid target, a blocked target or the same tile", () => {
    expect(bfsPath(ROOM_TILES, { x: 10, y: 8 }, { x: 0, y: 0 })).toEqual([]);
    expect(bfsPath(ROOM_TILES, { x: 10, y: 8 }, { x: 5, y: 12 })).toEqual([]); // table
    expect(bfsPath(ROOM_TILES, { x: 10, y: 8 }, { x: 11, y: 8 }, (x, y) => x === 11 && y === 8)).toEqual([]);
    expect(bfsPath(ROOM_TILES, { x: 10, y: 8 }, { x: 10, y: 8 })).toEqual([]);
  });

  it("steps around people", () => {
    const blocked = (x: number, y: number) => x === 11 && y === 8;
    const p = bfsPath(ROOM_TILES, { x: 10, y: 8 }, { x: 12, y: 8 }, blocked);
    expect(p.length).toBe(4);
  });

  it("reaches every chat seat from the door", () => {
    for (const s of ROOM_SEATS) expect(bfsPath(ROOM_TILES, ROOM_DOOR, s).length).toBeGreaterThan(0);
  });
});

describe("nearestFreeNeighbor", () => {
  it("picks the walkable side of furniture closest to me", () => {
    const n = nearestFreeNeighbor(ROOM_TILES, { x: 5, y: 12 }, { x: 5, y: 9 }); // table, from above
    expect(n).toEqual({ x: 5, y: 11 });
  });
  it("skips occupied tiles", () => {
    const n = nearestFreeNeighbor(ROOM_TILES, { x: 20, y: 8 }, { x: 20, y: 5 }, (x, y) => x === 20 && y === 7);
    expect(n).not.toEqual({ x: 20, y: 7 });
    expect(n).not.toBeNull();
  });
});

describe("volumes", () => {
  it("is the server audibility while both are in the room, else 0", () => {
    const me = m("me", 20, 8);
    expect(volumeFor(me, m("a", 21, 8))).toBe(1);
    expect(volumeFor(me, m("b", 23, 8))).toBeCloseTo(0.5);
    expect(volumeFor(me, m("c", 26, 8))).toBe(0);
    expect(volumeFor(me, m("d", 21, 8, { mode: "text" }))).toBe(0);
    expect(volumeFor(m("me", 20, 8, { mode: "text" }), m("a", 21, 8))).toBe(0);
  });
  it("the stage reaches everyone, the table is private", () => {
    const me = m("me", 20, 8);
    expect(volumeFor(me, m("s", 25, 2))).toBe(1);
    expect(volumeFor(me, m("t", 11, 12))).toBe(0); // inside the table zone, near me? still 0
    expect(volumeFor(m("me", 3, 11), m("t", 10, 14))).toBe(1);
  });
  it("maps every other member", () => {
    const v = volumesFor("me", [m("me", 20, 8), m("a", 21, 8), m("t", 6, 3, { mode: "text" })]);
    expect([...v.entries()]).toEqual([
      ["a", 1],
      ["t", 0],
    ]);
  });
});

describe("allowedListeners", () => {
  it("only listening room members who would hear me", () => {
    const members = [
      m("me", 20, 8),
      m("near", 21, 8),
      m("watch", 21, 9, { listening: false }),
      m("far", 28, 15),
      m("text", 6, 3, { mode: "text", listening: false }),
      m("table", 5, 11),
    ];
    expect(allowedListeners("me", members)).toEqual(["near"]);
  });
  it("on the stage everyone listening hears me", () => {
    const members = [m("me", 25, 2), m("far", 28, 15), m("table", 5, 11), m("b", 2, 2)];
    expect(allowedListeners("me", members)).toEqual(["b", "far", "table"]);
  });
  it("at the table only the table", () => {
    const members = [m("me", 3, 11), m("in", 10, 14), m("out", 12, 12)];
    expect(allowedListeners("me", members)).toEqual(["in"]);
  });
  it("nobody when I am not in the room view", () => {
    expect(allowedListeners("me", [m("me", 6, 3, { mode: "text" }), m("a", 7, 3)])).toEqual([]);
    expect(allowedListeners("ghost", [m("a", 7, 3)])).toEqual([]);
  });
  it("sameIds compares sorted lists", () => {
    expect(sameIds(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameIds(["a"], ["a", "b"])).toBe(false);
    expect(sameIds(null, [])).toBe(false);
    expect(sameIds([], [])).toBe(true);
  });
});

describe("marks, looks, bubbles", () => {
  it("status marks follow the spec", () => {
    expect(statusMark(m("a", 1, 1, { away: true, mode: "text" }), true)).toBe("💤");
    expect(statusMark(m("a", 1, 1, { mode: "text" }), false)).toBe("⌨️");
    expect(statusMark(m("a", 1, 1, { listening: false }), false)).toBe("👀");
    expect(statusMark(m("a", 1, 1), true)).toBe("🔊");
    expect(statusMark(m("a", 1, 1), false)).toBe("🎧");
  });
  it("same id, same look; looks vary", () => {
    expect(lookFor("u_abc")).toEqual(lookFor("u_abc"));
    const shirts = new Set(Array.from({ length: 40 }, (_, i) => lookFor(`user-${i}`).shirt));
    expect(shirts.size).toBeGreaterThan(3);
  });
  it("bubble text", () => {
    expect(bubbleText("  hi\n there ")).toBe("hi there");
    expect(bubbleText("", 2)).toBe("📷");
    expect(bubbleText("", 0)).toBeNull();
    expect([...(bubbleText("あ".repeat(80)) ?? "")].length).toBe(48);
  });
  it("voice counts", () => {
    const r = voiceCounts([m("a", 1, 1), m("b", 1, 1, { listening: false }), m("c", 1, 1, { mode: "text" }), m("d", 2, 2)], new Set(["d", "b"]));
    expect(r.inVoice.map((x) => x.userId)).toEqual(["a", "d"]);
    expect(r.talking).toBe(1);
  });
  it("the server map DTO is what the client reads", () => {
    const d = roomMapDto();
    expect(d.tiles.length).toBe(d.h);
    expect(d.tiles.every((r) => r.length === d.w)).toBe(true);
  });
});


describe("部室の拡大・縮小", () => {
  // 地図 32×20 タイル × 16px = 512×320。画面 780×400、自動の倍率 3
  const fit = roomFitZoom(780, 400, 512, 320);
  it("全体が収まる倍率は幅と高さの小さい方", () => {
    expect(fit).toBeCloseTo(1.25);
  });
  it("scale 1 は今までと同じ、範囲の外は丸める", () => {
    expect(roomZoom(3, fit, 1).zoom).toBe(3);
    expect(roomZoom(3, fit, 10).zoom).toBe(6);
    expect(roomZoom(3, fit, 0.01).zoom).toBeCloseTo(1.25);
    expect(roomZoom(3, fit, Number.NaN).zoom).toBe(3);
  });
  it("−/＋ は 1.25 倍ずつ、1.0 をまたぐときは 1.0 で止まる", () => {
    expect(nextRoomScale("in", 3, fit, 1)).toBeCloseTo(1.25);
    expect(nextRoomScale("out", 3, fit, 1)).toBeCloseTo(0.8);
    expect(nextRoomScale("in", 3, fit, 0.9)).toBe(1);
    expect(nextRoomScale("in", 3, fit, 2)).toBe(2);
  });
  it("全体 は全体が見える倍率と 1.0 を行き来する", () => {
    const s = nextRoomScale("fit", 3, fit, 1);
    expect(s).toBe(0);
    expect(roomZoom(3, fit, s).zoom).toBeCloseTo(1.25);
    expect(nextRoomScale("fit", 3, fit, s)).toBe(1);
    // 全体から ＋ は、今見えている倍率から 1.25 倍
    expect(nextRoomScale("in", 3, fit, 0)).toBeCloseTo((1.25 / 3) * 1.25);
    // 画面が広がっても 0 のままなので全体が見える
    expect(roomZoom(3, roomFitZoom(780, 700, 512, 320), 0).zoom).toBeCloseTo(780 / 512);
  });
  it("おかしな scale は 1 として扱う", () => {
    expect(roomZoom(3, fit, -2).zoom).toBe(3);
    expect(roomZoom(3, fit, Number.POSITIVE_INFINITY).zoom).toBe(3);
  });
  it("自動の倍率が全体より小さい（大きな画面）なら下限は自動の倍率", () => {
    expect(roomZoom(2, 4, 0.1).zoom).toBe(2);
  });
});

describe("頭の上の名前", () => {
  it("短い名前はそのまま、長い名前は幅 12 で切って …", () => {
    expect(shortRoomName("Ken")).toBe("Ken");
    expect(shortRoomName("ドリキン")).toBe("ドリキン");
    expect(shortRoomName("yatakaharu（グルペット）")).toBe("yatakaharu…");
    expect(shortRoomName("KOJI SHIGEMURA（しげ）")).toBe("KOJI SHIGEM…");
    expect(shortRoomName("散財王ドリキン様")).toBe("散財王ドリ…");
    expect(shortRoomName("  a\n b ")).toBe("a b");
    // ちょうど幅 12 はそのまま、13 で切る
    expect(shortRoomName("abcdefghijkl")).toBe("abcdefghijkl");
    expect(shortRoomName("abcdefghijklm")).toBe("abcdefghijk…");
    // 絵文字（ZWJ）・国旗の途中で切らない
    expect(shortRoomName("ab👨‍👩‍👧‍👦cdefghij")).toBe("ab👨‍👩‍👧‍👦cdefghij"); // ちょうど幅 12
    expect(shortRoomName("ab👨‍👩‍👧‍👦cdefghijk")).toBe("ab👨‍👩‍👧‍👦cdefghi…");
    expect(shortRoomName("🇯🇵🇯🇵🇯🇵🇯🇵🇯🇵🇯🇵🇯🇵")).toBe("🇯🇵🇯🇵🇯🇵🇯🇵🇯🇵…");
  });
});
