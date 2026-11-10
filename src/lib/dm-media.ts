/* ✉️ DM・👥 グループ DM の写真（2026-11-08 オーナー「DM もチャットと同様に画像を貼れるように」）。
 *
 *   - 上げ方はチャットと同じ（multipart images[]、最大 4 枚・1 枚 4MB、端末が長辺 1280px に縮め EXIF を落として送る）。
 *     ファイルは public/uploads/dm-…、URL は /api/media/dm-…。
 *   - 誰が上げたかを dm_uploads に残し、送るときは「自分が上げた写真」だけを付けられる（他人の写真の URL を
 *     自分の発言に付けて見られる相手を広げることはできない）。
 *   - 見られるのは、その写真が付いた DM の当事者 2 人・グループのいまのメンバー・上げた本人だけ
 *     （/api/media/[filename] が canViewDmMedia で確かめる。ほかの人には 404）。
 *   - DM と同じ 30 日で消える。送られなかった写真は 1 日で消える。
 *   - ファイルは public の外（data/dm-media、グループの写真の data/gdm-photos と同じ考え）に移す。public/uploads に
 *     置いたままだと next start が起動時に /uploads/<名前> で認証なしに配ってしまうため（セキュリティレビュー 2026-11-08）。 */
import path from "path";
import { copyFile, mkdir, readdir, rename, rm, stat } from "fs/promises";
import { pool } from "./db";
import { dmEnabledFor } from "./dm";
import { featureEnabledFor } from "./feature-flag";

export const DM_MAX_IMAGES = 4;
export const DM_UPLOAD_PREFIX = "dm-";
export const DM_IMAGE_RE = /^\/api\/media\/dm-[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/;
/** /api/media の dm- ファイル名の形（URL の最後の部分）。 */
export const DM_FILE_RE = /^dm-[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp|gif)$/;

const norm = (e: string) => (e || "").trim().toLowerCase();

/** DM の写真の置き場所（public の外。/api/media の dm- だけがここから読む）。 */
export function dmMediaDir(): string {
  return process.env.DM_MEDIA_DIR || path.join(process.cwd(), "data", "dm-media");
}
const uploadsDir = () => path.join(process.cwd(), "public", "uploads");

/** 上げた直後: public/uploads から dm-media へ移す（handleUpload の onSaved から）。 */
export async function moveDmUploads(urls: string[]): Promise<void> {
  const dir = dmMediaDir();
  await mkdir(dir, { recursive: true });
  for (const name of urls.filter((u) => DM_IMAGE_RE.test(u)).map(fileOf)) {
    const from = path.join(uploadsDir(), name);
    const to = path.join(dir, name);
    try {
      await rename(from, to);
    } catch {
      await copyFile(from, to); // 別のディスク
      await rm(from, { force: true });
    }
  }
}
const fileOf = (url: string) => url.slice("/api/media/".length);

/** 写真の形と枚数を確かめる（純粋関数）。null・未指定は []。形が違えば null。重複は 1 つに。 */
export function parseDmImages(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > DM_MAX_IMAGES) return null;
  if (raw.some((u) => typeof u !== "string" || !DM_IMAGE_RE.test(u))) return null;
  return [...new Set(raw as string[])];
}

/** 上げた写真を public の外へ移して記録する（/api/dm/upload・/api/agent/dm/upload の後）。 */
export async function recordDmUploads(email: string, urls: string[]): Promise<void> {
  await moveDmUploads(urls);
  const names = urls.filter((u) => DM_IMAGE_RE.test(u)).map(fileOf);
  if (names.length === 0) return;
  await pool.query(
    `INSERT INTO dm_uploads (name, uploader_email) SELECT unnest($1::text[]), $2 ON CONFLICT (name) DO NOTHING`,
    [names, norm(email)]
  );
}

/** 送り主が上げた写真だけか（上げてから 1 日以内のもの。古い写真を付け直すと、発言より先に掃除で消えるため）。 */
export async function allUploadedBy(email: string, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return true;
  const r = await pool.query(
    `SELECT count(*)::int AS c FROM dm_uploads
      WHERE name = ANY($1::text[]) AND uploader_email = $2 AND created_at > now() - interval '1 day'`,
    [urls.map(fileOf), norm(email)]
  );
  return Number(r.rows[0]?.c ?? 0) === urls.length;
}

/** この人がこの dm- ファイルを見てよいか（上げた本人・付いた DM の当事者・付いたグループのいまのメンバー・🌐 パブリック DM なら使える人全員。
 *  グループは発言と同じく、入る前の発言の写真は見られない（joined_from_id）。期限を過ぎた発言の写真は見せない）。 */
export async function canViewDmMedia(email: string, filename: string, ttl = "30 days"): Promise<boolean> {
  if (!DM_FILE_RE.test(filename)) return false;
  const me = norm(email);
  const url = `/api/media/${filename}`;
  const r = await pool.query(
    `SELECT EXISTS (SELECT 1 FROM dm_uploads WHERE name = $1 AND uploader_email = $2)
         OR EXISTS (SELECT 1 FROM dm_messages WHERE images @> ARRAY[$3]::text[] AND (sender_email = $2 OR recipient_email = $2)
                     AND created_at >= now() - ($4::text)::interval)
         OR EXISTS (SELECT 1 FROM gdm_messages m JOIN gdm_members gm ON gm.group_id = m.group_id AND gm.email = $2
                     WHERE m.images @> ARRAY[$3]::text[] AND m.id > gm.joined_from_id
                       AND m.created_at >= now() - ($4::text)::interval)
         -- 🌐 パブリック DM の写真は、グループ DM を使える人なら参加していなくても見られる（発言と同じ）
         OR ($5 AND EXISTS (SELECT 1 FROM gdm_messages m JOIN gdm_groups g ON g.id = m.group_id AND g.is_public
                     WHERE m.images @> ARRAY[$3]::text[] AND m.created_at >= now() - ($4::text)::interval)) AS ok`,
    [filename, me, url, ttl, dmEnabledFor(me) && featureEnabledFor("GROUP_DM_ENABLED", me)]
  );
  return !!r.rows[0]?.ok;
}

/** 消す: DM の期限（30 日）＋1 日を過ぎた写真と、どの発言にも付かないまま 1 日たった写真。消した数を返す。 */
export async function purgeDmMedia(ttl: string): Promise<number> {
  const r = await pool.query(
    `DELETE FROM dm_uploads u
      WHERE u.created_at < now() - ($1::text)::interval - interval '1 day'
         OR (u.created_at < now() - interval '1 day'
             AND NOT EXISTS (SELECT 1 FROM dm_messages d WHERE d.images @> ARRAY['/api/media/' || u.name]::text[])
             AND NOT EXISTS (SELECT 1 FROM gdm_messages g WHERE g.images @> ARRAY['/api/media/' || u.name]::text[]))
      RETURNING u.name`,
    [ttl]
  );
  const dir = dmMediaDir();
  const names = (r.rows as { name: string }[]).map((x) => x.name).filter((n) => DM_FILE_RE.test(n));
  await Promise.all(names.map((n) => rm(path.join(dir, n), { force: true }).catch(() => {})));
  // 記録より前に落ちたなどで記録の無いファイルも、古くなったら消す（期限＋2 日）。public/uploads に残った dm- も。
  const cutoff = Date.now() - (DM_FILE_MAX_AGE_MS);
  for (const d of [dir, uploadsDir()]) {
    let files: string[] = [];
    try {
      files = await readdir(d);
    } catch {
      continue;
    }
    for (const n of files) {
      if (!n.startsWith(DM_UPLOAD_PREFIX)) continue;
      const st = await stat(path.join(d, n)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await rm(path.join(d, n), { force: true }).catch(() => {});
    }
  }
  return names.length;
}

/** 記録の無い dm- ファイルを消すまでの時間（DM の 30 日＋2 日）。 */
const DM_FILE_MAX_AGE_MS = 32 * 24 * 60 * 60 * 1000;
