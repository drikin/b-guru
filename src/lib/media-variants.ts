/* /api/media の投稿画像を、サイズ別の縮小版（EXIF なし）で返すためのディスクキャッシュ。
 *
 *   - 原本（public/uploads/<name>）は読むだけで、消したり上書きしたりしない。
 *   - 縮小版は data/media-cache/<name>__<w><ext> に一度だけ作り、以後はそれを返す。
 *   - 縮小も EXIF 除去も要らない画像（新しい投稿は保存時に処理済み・小さい画像）は原本をそのまま返す。
 *     その判定はメモリに覚える（毎回メタデータを読まない）。
 *   - チャット写真（chat-…）は端末で 1280px・EXIF なしにしてあるので対象外（扱いを変えない）。
 *   - GIF・アニメーション・読めない画像は原本のまま（動きを壊さない）。 */
import { mkdir, readdir, rename, rm, stat, writeFile } from "fs/promises";
import path from "path";
import crypto from "crypto";
import {
  POST_IMAGE_MAX_SIDE,
  canPassThrough,
  extForFormat,
  imageInfo,
  mimeForFormat,
  pickMediaWidth,
  resizeImage,
} from "./image-resize";

const VARIANT_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);
/** キャッシュの上限。超えたら古い半分を消す（原本の 1/2〜1/3 程度に収まる見込み）。 */
const MAX_CACHE_BYTES = 3 * 1024 * 1024 * 1024;

export function mediaCacheDir(): string {
  return process.env.BGURU_MEDIA_CACHE_DIR || path.join(/*turbopackIgnore: true*/ process.cwd(), "data", "media-cache");
}

/** A path inside the cache dir. The ignore comment keeps Turbopack from tracing
 *  the whole project for these runtime-only files (like data/img-cache). */
function inCache(...parts: string[]): string {
  return path.join(/*turbopackIgnore: true*/ mediaCacheDir(), ...parts);
}

/** 縮小版を作る対象か（名前だけで決まる部分）。 */
export function isVariantCandidate(filename: string): boolean {
  if (filename.startsWith("chat-")) return false;
  return VARIANT_EXTS.has(path.extname(filename).toLowerCase());
}

/** 縮小版のファイル名。w は MEDIA_WIDTHS のどれか。 */
export function variantName(filename: string, w: number, ext: string): string {
  return `${filename}__${w}${ext}`;
}

type Decision = { pass: true } | { pass: false; name: string; contentType: string };
/** filename|w → 判定（原本のまま返す／この縮小版を返す）。プロセスが生きている間だけ覚える。 */
const decisions = new Map<string, Decision>();
const MAX_DECISIONS = 20_000;
/** 同じ縮小版を同時に二度作らない。 */
const inflight = new Map<string, Promise<Decision>>();

export type Variant = { path: string; contentType: string; label: string };

/**
 * 投稿画像の配信用の版を返す。null なら原本をそのまま返してよい。
 * @param wParam ?w= の生の値（null なら既定の長辺 2048）
 */
export async function mediaVariant(filename: string, originalPath: string, wParam: string | null): Promise<Variant | null> {
  if (!isVariantCandidate(filename)) return null;
  const w = pickMediaWidth(wParam) ?? POST_IMAGE_MAX_SIDE;
  const key = `${filename}|${w}`;
  let d = decisions.get(key);
  if (!d) {
    let p = inflight.get(key);
    if (!p) {
      p = decide(filename, originalPath, w).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    d = await p;
    if (decisions.size >= MAX_DECISIONS) decisions.clear();
    decisions.set(key, d);
  }
  if (d.pass) return null;
  const vpath = inCache(d.name);
  try {
    await stat(vpath);
  } catch {
    // キャッシュが消された（容量の掃除など）→ 作り直す。
    decisions.delete(key);
    const again = await decide(filename, originalPath, w);
    decisions.set(key, again);
    if (again.pass) return null;
    return { path: inCache(again.name), contentType: again.contentType, label: `w${w}` };
  }
  return { path: vpath, contentType: d.contentType, label: `w${w}` };
}

async function decide(filename: string, originalPath: string, w: number): Promise<Decision> {
  const dir = inCache();
  // すでに作ってある縮小版（再起動後など）。形式は原本と同じか、拡張子違いの実体の形式。
  for (const ext of [".jpg", ".png", ".webp"]) {
    const name = variantName(filename, w, ext);
    try {
      await stat(inCache(name));
      return { pass: false, name, contentType: mimeForFormat(ext === ".jpg" ? "jpeg" : ext.slice(1)) };
    } catch {
      /* not cached */
    }
  }
  try {
    const info = await imageInfo(originalPath);
    if (canPassThrough(info, w)) return { pass: true };
    const out = await resizeImage(originalPath, w);
    const ext = extForFormat(out.format);
    const name = variantName(filename, w, ext);
    await mkdir(dir, { recursive: true });
    // 書きかけのファイルを返さないよう、一時名に書いてから置き換える。
    const tmp = inCache(`.tmp-${crypto.randomBytes(6).toString("hex")}`);
    await writeFile(tmp, out.data);
    await rename(tmp, inCache(name));
    noteWritten(out.data.byteLength);
    return { pass: false, name, contentType: mimeForFormat(out.format) };
  } catch (err) {
    // 読めない・壊れた画像は原本のまま（以前と同じ挙動）。
    console.warn("[media] variant failed, serving original:", filename, err instanceof Error ? err.message : err);
    return { pass: true };
  }
}

// ---- 容量の管理（書いた量を数え、上限を超えたら古い半分を消す）----
let cacheBytes: number | null = null;
let evicting = false;

function noteWritten(n: number): void {
  if (cacheBytes === null) {
    void measure();
    return;
  }
  cacheBytes += n;
  if (cacheBytes > MAX_CACHE_BYTES) void evict();
}

async function measure(): Promise<void> {
  const dir = inCache();
  let total = 0;
  try {
    for (const f of await readdir(dir)) {
      try {
        total += (await stat(inCache(f))).size;
      } catch {
        /* raced */
      }
    }
  } catch {
    /* no dir yet */
  }
  cacheBytes = total;
  if (cacheBytes > MAX_CACHE_BYTES) void evict();
}

async function evict(): Promise<void> {
  if (evicting) return;
  evicting = true;
  try {
    const dir = inCache();
    const files = await readdir(dir);
    const entries = await Promise.all(
      files.map(async (f) => {
        try {
          const s = await stat(inCache(f));
          return { f, mtime: s.mtimeMs, size: s.size };
        } catch {
          return { f, mtime: 0, size: 0 };
        }
      })
    );
    entries.sort((a, b) => a.mtime - b.mtime);
    for (const e of entries.slice(0, Math.floor(entries.length / 2))) {
      await rm(inCache(e.f), { force: true });
      if (cacheBytes !== null) cacheBytes -= e.size;
    }
    // 消した縮小版の判定は、次の配信で stat に失敗して作り直される。
  } catch {
    /* best-effort */
  } finally {
    evicting = false;
  }
}

/** テスト用: メモリの判定を捨てる。 */
export function _resetMediaVariantsForTest(): void {
  decisions.clear();
  inflight.clear();
  cacheBytes = null;
}
