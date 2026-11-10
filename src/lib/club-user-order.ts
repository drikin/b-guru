/* 部活一覧の「自分の並び順」と「部活ごとの未読数」（アプリの部活一覧。2026-11-09 ドリキン
 * 「左スワイプの部活一覧に未読数も出して、自分でカスタマイズした順番か未読順かで選べるように」）。
 *   - 並び順はサーバに覚える（全端末で同じ。オーナー 2026-11-09「サーバ（全端末で同じ）」）。
 *     club_user_order に 1 行 = 1 部活（position の昇順）。並べていない部活はカタログ順で後ろに続く。
 *   - 未読数は「まだ読んでいない投稿」（オーナー 2026-11-09。返信は数えない）＝タイムラインの未読と
 *     同じ数え方: ほかの人のルート投稿で、post_read_state に無いもの。NG ワードで隠れる投稿は数えない。
 *     既読の記録は 2026-09-27 からなので、それより前の投稿が全部未読にならないよう直近 UNREAD_DAYS 日だけ。 */
import { pool } from "./db";
import { getMutedWords, noMutedWordSql } from "./muted-words";

export const UNREAD_DAYS = 30;
/** 並び順に覚える部活の数の上限（カタログは数十。安全弁）。 */
export const MAX_ORDER = 200;

const KEY_RE = /^[a-z0-9_-]{1,40}$/;

/** 送られた並び順を整える（純粋関数）: 文字列・形の正しいキーだけ、重複は最初の 1 回、上限まで。 */
export function normalizeOrder(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const k = v.trim();
    if (!KEY_RE.test(k) || out.includes(k)) continue;
    out.push(k);
    if (out.length >= MAX_ORDER) break;
  }
  return out;
}

/** この人の並び順（並べた順。並べていなければ空）。 */
export async function getClubOrder(email: string): Promise<string[]> {
  const r = await pool.query(
    `SELECT club_key FROM club_user_order WHERE email = $1 ORDER BY position, club_key`,
    [email]
  );
  return r.rows.map((x: { club_key: string }) => x.club_key);
}

/** 並び順を丸ごと置き換える（空の配列 = 並べ直しを消してカタログ順に戻す）。 */
export async function setClubOrder(email: string, keys: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM club_user_order WHERE email = $1`, [email]);
    if (keys.length > 0) {
      await client.query(
        `INSERT INTO club_user_order (email, club_key, position)
         SELECT $1, k, ord::int FROM unnest($2::text[]) WITH ORDINALITY AS t(k, ord)`,
        [email, keys]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 部活ごとの未読の投稿の数（0 の部活は入らない。未設定は "__unset__"）。 */
export async function getClubUnreadCounts(email: string): Promise<Record<string, number>> {
  const words = await getMutedWords(email);
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(p.club, ''), '__unset__') AS club, count(*)::int AS n
       FROM posts p
      WHERE p.parent_id IS NULL
        AND p.created_at > now() - make_interval(days => $2::int)
        AND lower(p.author_email) <> lower($1)
        AND NOT EXISTS (SELECT 1 FROM post_read_state r WHERE r.email = $1 AND r.post_id = p.id)${
          words.length > 0 ? `
        AND ${noMutedWordSql("p.text", "$3")}` : ""}
      GROUP BY 1`,
    words.length > 0 ? [email, UNREAD_DAYS, words] : [email, UNREAD_DAYS]
  );
  const out: Record<string, number> = {};
  for (const row of r.rows as { club: string; n: number }[]) out[row.club] = row.n;
  return out;
}
