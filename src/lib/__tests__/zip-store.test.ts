import { describe, expect, it } from "vitest";
import { crc32, zipStream } from "../zip-store";

async function collect(s: ReadableStream<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    parts.push(value);
  }
  return Buffer.concat(parts);
}

describe("zip-store", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes stored entries with UTF-8 names and skips missing files", async () => {
    const a = new Uint8Array([1, 2, 3, 4]);
    const buf = await collect(
      zipStream([
        { name: "001_ドリキン_1930.jpg", mtime: new Date(2026, 9, 26, 19, 30, 10), read: async () => a },
        { name: "002_消えた.jpg", mtime: new Date(), read: async () => null },
        { name: "003_b.jpg", mtime: new Date(2026, 9, 26, 20, 0, 0), read: async () => new Uint8Array(0) },
      ]),
    );
    const end = buf.length - 22;
    expect(buf.readUInt32LE(end)).toBe(0x06054b50);
    expect(buf.readUInt16LE(end + 10)).toBe(2); // 消えたファイルは入らない
    const dirSize = buf.readUInt32LE(end + 12);
    const dirAt = buf.readUInt32LE(end + 16);
    expect(dirAt + dirSize).toBe(end);
    // 1 件目: 名前・UTF-8 の印・中身・CRC
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    expect(buf.readUInt16LE(6) & 0x0800).toBe(0x0800);
    const nameLen = buf.readUInt16LE(26);
    expect(buf.subarray(30, 30 + nameLen).toString("utf8")).toBe("001_ドリキン_1930.jpg");
    expect([...buf.subarray(30 + nameLen, 30 + nameLen + 4)]).toEqual([1, 2, 3, 4]);
    expect(buf.readUInt32LE(14)).toBe(crc32(a));
    // 中央の 2 件目は 2 つ目のローカルヘッダを指す
    const cen1Name = buf.readUInt16LE(dirAt + 28);
    const cen2 = dirAt + 46 + cen1Name;
    expect(buf.readUInt32LE(cen2)).toBe(0x02014b50);
    expect(buf.readUInt32LE(buf.readUInt32LE(cen2 + 42))).toBe(0x04034b50);
  });
});
