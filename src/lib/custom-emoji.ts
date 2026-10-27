/* カスタム絵文字の登録・削除（Web の /api/emojis と、アプリの /api/agent/emojis で同じ）。
 * 2026-10-27 オーナー「誰でもどこからでも絵文字を登録削除できるようにする」: 削除も誰でも（前は登録した本人と管理者だけ）。
 * 消すとその絵文字のリアクションも消えるので、誰が登録・削除したかを custom_emoji_log に残し、回数に枠を設ける。 */
import { writeFile, mkdir, rm } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { pool } from "./db";
import { createCustomEmoji, deleteCustomEmoji, type CustomEmoji } from "./reactions";

// Custom emoji images are small by nature — they render at ~20px in a chip.
// 256KB is generous for a PNG/GIF and keeps a single upload from filling the disk.
export const EMOJI_MAX_BYTES = 256 * 1024;
const ALLOWED: Record<string, string> = { "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp", "image/jpeg": ".jpg" };
/** 1 人 1 時間に登録・削除できる回数（それぞれ）。 */
export const EMOJI_ACTIONS_PER_HOUR = 20;

export class EmojiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

const recent = new Map<string, number[]>();
function rateOk(kind: "create" | "delete", email: string, now = Date.now()): boolean {
  const k = `${kind}:${email.toLowerCase()}`;
  const xs = (recent.get(k) ?? []).filter((t) => now - t < 3600_000);
  if (xs.length >= EMOJI_ACTIONS_PER_HOUR) {
    recent.set(k, xs);
    return false;
  }
  xs.push(now);
  recent.set(k, xs);
  return true;
}

async function log(action: "create" | "delete", name: string, imageUrl: string | null, email: string): Promise<void> {
  await pool
    .query(`INSERT INTO custom_emoji_log (action, emoji_name, image_url, by_email) VALUES ($1, $2, $3, lower($4))`, [action, name, imageUrl, email])
    .catch((e) => console.error("emoji log:", (e as Error)?.message));
}

/** 名前と画像から登録する。 */
export async function registerCustomEmoji(email: string, rawName: unknown, file: unknown): Promise<CustomEmoji> {
  const name = String(rawName ?? "").trim();
  if (!(file instanceof File)) throw new EmojiError(400, "invalid_request", "画像が必要です");
  const ext = ALLOWED[file.type];
  if (!ext) throw new EmojiError(400, "invalid_request", "PNG / GIF / WebP / JPEG のみ登録できます");
  if (file.size > EMOJI_MAX_BYTES) throw new EmojiError(400, "too_large", "画像は256KBまでです");
  if (!rateOk("create", email)) throw new EmojiError(429, "rate_limited", "登録が多すぎます。少し待ってください");
  const filename = `emoji-${crypto.randomBytes(8).toString("hex")}${ext}`;
  const dir = path.join(process.cwd(), "public", "uploads");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, filename), Buffer.from(await file.arrayBuffer()));
  try {
    // Served through /api/media so runtime-uploaded files do not hit the `public/` build-manifest 404 problem.
    const emoji = await createCustomEmoji(name, `/api/media/${filename}`, email);
    await log("create", emoji.name, emoji.imageUrl, email);
    return emoji;
  } catch (e) {
    await rm(path.join(dir, filename), { force: true }); // 登録できなかった画像は残さない
    const m = (e as Error).message;
    if (m === "invalid_name") throw new EmojiError(400, "invalid_name", "名前は英小文字・数字・_ のみ、32文字までです");
    if (m === "name_taken") throw new EmojiError(409, "name_taken", "その名前は既に使われています");
    throw e;
  }
}

/** 誰でも消せる（その絵文字のリアクションも消える）。 */
export async function removeCustomEmoji(email: string, rawId: unknown): Promise<void> {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) throw new EmojiError(400, "invalid_request", "不正なID");
  if (!rateOk("delete", email)) throw new EmojiError(429, "rate_limited", "削除が多すぎます。少し待ってください");
  try {
    const gone = await deleteCustomEmoji(id);
    await log("delete", gone.name, gone.imageUrl, email);
  } catch (e) {
    if ((e as Error).message === "not_found") throw new EmojiError(404, "not_found", "絵文字が見つかりません");
    throw e;
  }
}

export function _resetEmojiRateForTest(): void {
  recent.clear();
}
