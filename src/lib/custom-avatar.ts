/**
 * 自分で上げたアイコン（2026-11-16）。
 *
 * アイコンの URL はどこでも gravatarUrl(email) = /api/avatar/<メールの md5>。ここに上げた画像があれば
 * /api/avatar/<md5> が Gravatar より先にそれを返すので、Web・アプリ・部室・ボイスなど全部の表示が
 * そのまま切り替わる（アプリの変更なし）。
 *
 *   - 画像は data/avatars/<md5>-<px>.jpg（public の外）。上げたときに sharp で正方形に切り、
 *     向きを直し EXIF/GPS を落とした JPEG を AVATAR_SIZES と 512 の各大きさで作っておく。
 *   - 版（version）を URL の ?v= に付ける。/api/avatar は 7 日 immutable でキャッシュされるので、
 *     変えたら URL ごと変えないと古い顔が残る。版の一覧はメモリに持つ（pm2 は 1 プロセス）。
 *     起動時と 60 秒ごとに DB から読み直す。
 */
import crypto from "crypto";
import path from "path";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { pool } from "./db";
import { AVATAR_SIZES } from "./avatar-size";

export const CUSTOM_AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const MASTER_PX = 512;
const OUT_SIZES = [...AVATAR_SIZES, MASTER_PX] as const;
const MD5_RE = /^[a-f0-9]{32}$/;

function avatarDir(): string {
  return process.env.CUSTOM_AVATAR_DIR || path.join(process.cwd(), "data", "avatars");
}

export function emailMd5(email: string): string {
  return crypto.createHash("md5").update((email || "").trim().toLowerCase()).digest("hex");
}

// md5 → version（上げた時刻のミリ秒）
const versions = new Map<string, number>();

/** 上げたアイコンがあれば ?v=版 を付けた URL、なければ素の /api/avatar/<md5>。 */
export function avatarPathForMd5(md5: string): string {
  const v = versions.get(md5);
  return v ? `/api/avatar/${md5}?v=${v}` : `/api/avatar/${md5}`;
}

export function hasCustomAvatar(md5: string): boolean {
  return versions.has(md5);
}

/** テスト用: メモリの版を直接入れる。 */
export function __setVersionForTest(md5: string, v: number | null) {
  if (v == null) versions.delete(md5);
  else versions.set(md5, v);
}

export async function reloadCustomAvatars(): Promise<void> {
  const r = await pool.query<{ md5: string; version: string }>(`SELECT md5, version FROM user_avatars`);
  const next = new Map<string, number>();
  for (const row of r.rows) next.set(row.md5, Number(row.version));
  versions.clear();
  for (const [k, v] of next) versions.set(k, v);
}

let timer: ReturnType<typeof setInterval> | null = null;
/** 起動時（instrumentation）に一度。 */
export function ensureCustomAvatars() {
  if (timer) return;
  reloadCustomAvatars().catch((e) => console.error("[avatar] load failed:", e));
  timer = setInterval(() => {
    reloadCustomAvatars().catch(() => {});
  }, 60_000);
  timer.unref?.();
}

function filePath(md5: string, px: number) {
  return path.join(avatarDir(), `${md5}-${px}.jpg`);
}

/** 配信用: 一番近い大きさ（以上）のファイル。なければ null。 */
export async function readCustomAvatar(md5: string, px: number): Promise<Buffer | null> {
  if (!MD5_RE.test(md5) || !versions.has(md5)) return null;
  const pick = OUT_SIZES.find((s) => s >= px) ?? MASTER_PX;
  try {
    return await readFile(filePath(md5, pick));
  } catch {
    return null;
  }
}

/** 画像（そのままのバイト）を正方形の JPEG にして各大きさで書く。読めない画像は Error。 */
export async function renderAvatarSizes(input: Buffer): Promise<Map<number, Buffer>> {
  const sharp = (await import("sharp")).default;
  // 4000 万画素まで。アニメーションは 1 枚目だけ。
  const base = sharp(input, { limitInputPixels: 40_000_000, animated: false, failOn: "error" }).rotate();
  const meta = await base.metadata();
  if (!meta.width || !meta.height) throw new Error("画像を読めませんでした");
  const out = new Map<number, Buffer>();
  for (const px of OUT_SIZES) {
    const buf = await base
      .clone()
      .resize(px, px, { fit: "cover", position: "centre" })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 86, mozjpeg: true })
      .toBuffer(); // withMetadata を呼ばないので EXIF/GPS は落ちる
    out.set(px, buf);
  }
  return out;
}

/** 上げる。新しい URL を返す。 */
export async function saveCustomAvatar(email: string, input: Buffer): Promise<string> {
  if (input.length > CUSTOM_AVATAR_MAX_BYTES) throw new Error("画像が大きすぎます（10MB まで）");
  const md5 = emailMd5(email);
  const sizes = await renderAvatarSizes(input).catch(() => {
    throw new Error("この画像は使えません（JPEG・PNG・WebP・HEIC などの写真を選んでください）");
  });
  const dir = avatarDir();
  await mkdir(dir, { recursive: true });
  // 一時ファイルに書いてから rename（配信中に半端なファイルを返さない）
  const tag = crypto.randomBytes(4).toString("hex");
  for (const [px, buf] of sizes) {
    const tmp = path.join(dir, `.${md5}-${px}.${tag}.tmp`);
    await writeFile(tmp, buf);
    await rename(tmp, filePath(md5, px));
  }
  const version = Date.now();
  await pool.query(
    `INSERT INTO user_avatars (md5, email, version, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (md5) DO UPDATE SET email = EXCLUDED.email, version = EXCLUDED.version, updated_at = now()`,
    [md5, email.trim().toLowerCase(), version]
  );
  versions.set(md5, version);
  return avatarPathForMd5(md5);
}

/** 消して Gravatar に戻す。戻った後の URL を返す。 */
export async function deleteCustomAvatar(email: string): Promise<string> {
  const md5 = emailMd5(email);
  await pool.query(`DELETE FROM user_avatars WHERE md5 = $1`, [md5]);
  versions.delete(md5);
  await Promise.all(OUT_SIZES.map((px) => rm(filePath(md5, px), { force: true })));
  return avatarPathForMd5(md5);
}
