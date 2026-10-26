/* 無圧縮（stored）の zip を 1 ファイルずつ流す。写真（JPEG など）はもう圧縮されているので縮めない。
 * 依存を増やさないための最小の実装: ZIP64 なし（4 GB・65535 件まで）、名前は UTF-8（bit 11）。
 * 🍻 オフ会のアルバムのまとめて保存（lib/offkai.ts photosForDownload）で使う。 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** zip の日時（DOS 形式、2 秒刻み）。時計は表示用なので、渡された Date のローカル時刻をそのまま入れる。 */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export type ZipEntry = { name: string; mtime: Date; read: () => Promise<Uint8Array | null> };

const LIMIT = 0xffffffff;

/** entries を順に読み、zip のバイト列として流す。read が null を返したもの（消えたファイル）は飛ばす。 */
export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      while (i < entries.length) {
        const e = entries[i++];
        const data = await e.read();
        if (!data) continue;
        if (count >= 0xffff || offset + data.length + 30 + 4096 > LIMIT) throw new Error("zip too large");
        const name = Buffer.from(e.name, "utf8");
        const crc = crc32(data);
        const { time, date } = dosTime(e.mtime);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // 展開に要る版 2.0
        local.writeUInt16LE(0x0800, 6); // 名前は UTF-8
        local.writeUInt16LE(0, 8); // 無圧縮
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        local.writeUInt16LE(0, 28);
        const cen = Buffer.alloc(46);
        cen.writeUInt32LE(0x02014b50, 0);
        cen.writeUInt16LE(20, 4);
        cen.writeUInt16LE(20, 6);
        cen.writeUInt16LE(0x0800, 8);
        cen.writeUInt16LE(0, 10);
        cen.writeUInt16LE(time, 12);
        cen.writeUInt16LE(date, 14);
        cen.writeUInt32LE(crc, 16);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(data.length, 24);
        cen.writeUInt16LE(name.length, 28);
        cen.writeUInt32LE(offset, 42);
        central.push(cen, name);
        offset += local.length + name.length + data.length;
        count++;
        ctrl.enqueue(new Uint8Array(Buffer.concat([local, name, Buffer.from(data.buffer, data.byteOffset, data.byteLength)])));
        return;
      }
      const dir = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(count, 8);
      end.writeUInt16LE(count, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(offset, 16);
      ctrl.enqueue(new Uint8Array(Buffer.concat([dir, end])));
      ctrl.close();
    },
  });
}
