/* 画像の縮小と EXIF（位置情報）除去 — 投稿画像（/api/upload・/api/media）と外部 OG 画像（/api/img）で共通。
 *
 * iPhone の原寸（5712×4284・6MB、EXIF に GPS 付き）をそのまま配っていたのを、
 *   - 保存時: 長辺 POST_IMAGE_MAX_SIDE（2048）に縮小し、向き（EXIF Orientation）を画素に反映してから
 *     EXIF/XMP/IPTC を落とす（ICC プロファイルだけは色のために残す。個人情報は入らない）。
 *   - 配信時: 既存の原本は書き換えず、?w= のサイズ別の縮小版をその場で作ってディスクにキャッシュ。
 * にする。sharp は libvips のネイティブメモリを使うので、同時に動かす数を絞る（pm2 の
 * max_memory_restart 400M に当たらないように）。 */
import sharp from "sharp";

/** 投稿画像の保存時・既定の配信の長辺。 */
export const POST_IMAGE_MAX_SIDE = 2048;
/** /api/media の ?w= で選べる長辺。これ以外の値は近い上のサイズに丸める（キャッシュを増やさない）。 */
export const MEDIA_WIDTHS = [320, 640, 1280, 2048] as const;
/** 外部 OG 画像（/api/img）の長辺。カードの表示幅 ~500px × 2x で足りる。 */
export const PROXY_IMAGE_MAX_SIDE = 1280;

/** 1 枚の画素数の上限（2 億画素超はデコードしない＝画像爆弾よけ）。 */
const LIMIT_INPUT_PIXELS = 200_000_000;
const JPEG_QUALITY = 82;
const WEBP_QUALITY = 80;

// libvips の操作キャッシュは使わない（同じ入力を二度処理しない。メモリを溜めない）。
sharp.cache(false);

/** 同時に動かす sharp の数（1 枚の 24MP JPEG で数十 MB のネイティブメモリを使う）。 */
const MAX_CONCURRENT = 2;
let active = 0;
const waiters: Array<() => void> = [];
export async function withImageSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiters.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}

/** ?w= の値を許すサイズに丸める。未指定・不正は null（＝既定の 2048）。 */
export function pickMediaWidth(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  for (const w of MEDIA_WIDTHS) if (n <= w) return w;
  return POST_IMAGE_MAX_SIDE;
}

export type ImageInfo = {
  format: string | undefined;
  width: number;
  height: number;
  pages: number;
  /** EXIF / XMP / IPTC のどれかを持つ（位置情報が入りうる）。 */
  hasPrivateMeta: boolean;
  /** EXIF Orientation が 1（そのまま）以外。 */
  needsRotate: boolean;
};

export async function imageInfo(input: Buffer | string): Promise<ImageInfo> {
  const m = await sharp(input, { limitInputPixels: LIMIT_INPUT_PIXELS }).metadata();
  return {
    format: m.format,
    width: m.width ?? 0,
    height: m.height ?? 0,
    pages: m.pages ?? 1,
    hasPrivateMeta: !!(m.exif || m.xmp || m.iptc),
    needsRotate: !!m.orientation && m.orientation !== 1,
  };
}

/** 縮小・再エンコードの対象にする形式（GIF・アニメは動きを守るためそのまま）。 */
export function isProcessable(info: ImageInfo): boolean {
  return (info.format === "jpeg" || info.format === "png" || info.format === "webp") && info.pages <= 1;
}

/** 手を入れずに原本のまま返してよいか（縮小不要・メタデータなし・向きそのまま）。 */
export function canPassThrough(info: ImageInfo, maxSide: number): boolean {
  if (!isProcessable(info)) return true;
  return !info.hasPrivateMeta && !info.needsRotate && Math.max(info.width, info.height) <= maxSide;
}

export type ResizeResult = { data: Buffer; format: "jpeg" | "png" | "webp"; width: number; height: number };

/**
 * 長辺 maxSide に収め（拡大はしない）、向きを画素に反映し、EXIF/XMP/IPTC を落とす。
 * 出力形式は入力と同じ（jpeg/png/webp）。`toWebp` なら不透明・透過どちらも WebP にする（/api/img 用）。
 * 処理できない形式（GIF・アニメ・不明）は例外を投げる — 呼び出し側で原本にフォールバックする。
 */
export async function resizeImage(
  input: Buffer | string,
  maxSide: number,
  opts: { toWebp?: boolean } = {}
): Promise<ResizeResult> {
  return withImageSlot(async () => {
    const info = await imageInfo(input);
    if (!isProcessable(info)) throw new Error(`not processable: ${info.format} pages=${info.pages}`);
    let p = sharp(input, { autoOrient: true, failOn: "error", limitInputPixels: LIMIT_INPUT_PIXELS })
      .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
      // 既定でメタデータは全部落ちる。色が変わらないよう ICC だけは残す（Display P3 の写真など）。
      .keepIccProfile();
    const fmt: ResizeResult["format"] = opts.toWebp ? "webp" : (info.format as ResizeResult["format"]);
    if (fmt === "jpeg") p = p.jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: false });
    else if (fmt === "png") p = p.png({ compressionLevel: 8, adaptiveFiltering: true });
    else p = p.webp({ quality: WEBP_QUALITY, effort: 4 });
    const { data, info: out } = await p.toBuffer({ resolveWithObject: true });
    return { data, format: fmt, width: out.width, height: out.height };
  });
}

export function mimeForFormat(f: string): string {
  return f === "jpeg" ? "image/jpeg" : f === "png" ? "image/png" : f === "webp" ? "image/webp" : "application/octet-stream";
}

export function extForFormat(f: string): string {
  return f === "jpeg" ? ".jpg" : f === "png" ? ".png" : f === "webp" ? ".webp" : "";
}

/** Shrink an external image to PROXY_IMAGE_MAX_SIDE on the long side. JPEG stays
 *  JPEG; PNG/WebP become WebP (all our clients decode it: browsers, iOS 17+,
 *  Android 9+). SVG, GIF, animations and anything sharp cannot read pass through,
 *  and the original is kept whenever the re-encode would not be smaller. */
export async function shrinkProxyImage(buf: Buffer, ct: string): Promise<{ buf: Buffer; ct: string }> {
  const type = ct.split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/jpg", "image/pjpeg", "image/png", "image/webp"].includes(type)) return { buf, ct };
  try {
    const out = await resizeImage(buf, PROXY_IMAGE_MAX_SIDE, { toWebp: !type.includes("jp") });
    if (out.data.byteLength < buf.byteLength) return { buf: out.data, ct: mimeForFormat(out.format) };
  } catch {
    /* unreadable / animated → as sent */
  }
  return { buf, ct };
}
