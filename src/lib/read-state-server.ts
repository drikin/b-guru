/**
 * 既読状態のサーバー永続化（tochi 2026-09-27「PCとスマホの両方でみた場合に、
 * 未読管理を共通管理にしたい」）。
 *
 * 設計の要点:
 *   - 粒度は post.id 単位・返信独立。従来の localStorage 実装と同一で、
 *     保存先だけをサーバーに移す（振る舞いを変えない）
 *   - カーソル方式は使わない。返信 ID は常に親より大きいので、カーソルだと
 *     「返信を読んだ」で親も既読になる。COLLAPSE_THRESHOLD=4 で折りたたまれた
 *     返信は親だけが見えるので、開いたときに未読が出なくなる
 *   - notifications の read_at（per-row 既読）が正しい先行例
 */

import { pool } from "./db";
import { MAX_READ_BATCH, normalizeReadIds } from "./read-state";

/**
 * 指定ユーザーの既読 post_id を返す。
 *
 * ★ 剪定しない。jump-to-post は最大 4,000 ルートまで遡ってマウントするので、
 *   保持件数を切ると古い投稿が未読として復活する。
 */
export async function getReadPostIds(email: string): Promise<number[]> {
  if (!email) return [];
  const res = await pool.query(
    `SELECT post_id FROM post_read_state WHERE email = $1`,
    [email]
  );
  return res.rows.map((r: { post_id: number }) => r.post_id);
}

/**
 * 既読を記録する（単調・冪等）。
 *
 * ★★ `WHERE EXISTS` は必須。実測で証明した:
 *     ON CONFLICT DO NOTHING だけ → ERROR: violates foreign key constraint
 *                                   （文全体がアボートし、生きている ID も失われる）
 *     WHERE EXISTS を挟む        → INSERT 0 1（生きている ID だけ入る）
 *
 *   クライアントは楽観更新した ID をデバウンスして送る。その間に他ユーザーが
 *   投稿を削除すると（ON DELETE CASCADE で posts から消える）、配列に死んだ ID が
 *   残る。FK 違反でバッチ全体がアボートすると、**生きている ID も一緒に失われ**、
 *   クライアントは成功と誤認して再送しないので既読がサイレントに欠落する。
 *
 * ★ 件数上限も必須。nginx の client_max_body_size は 85m、DB プールは max: 10、
 *   pm2 は fork_mode（単一プロセス）なので、巨大配列を数リクエスト投げるだけで
 *   サイト全体が無応答になる。
 *
 * @returns 実際に挿入された行数
 */
export async function markPostsRead(
  email: string,
  ids: unknown
): Promise<number> {
  if (!email) return 0;
  const clean = normalizeReadIds(ids).slice(0, MAX_READ_BATCH);
  if (clean.length === 0) return 0;

  const res = await pool.query(
    `INSERT INTO post_read_state (email, post_id)
     SELECT $1, u FROM unnest($2::int[]) AS u
     WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = u)
     ON CONFLICT DO NOTHING`,
    [email, clean]
  );
  return res.rowCount ?? 0;
}

/**
 * 複数の投稿について「このユーザーが既読か」を一括で返す。
 *
 * フィード応答に readIds を同梱するために使う。新規 GET エンドポイントを
 * 作らないことで往復を増やさない（オーナー制約「パフォーマンスは低下させない」）。
 */
export async function getReadIdsForPosts(
  email: string,
  postIds: number[]
): Promise<number[]> {
  if (!email || postIds.length === 0) return [];
  const clean = normalizeReadIds(postIds);
  if (clean.length === 0) return [];
  const res = await pool.query(
    `SELECT post_id FROM post_read_state
     WHERE email = $1 AND post_id = ANY($2::int[])`,
    [email, clean]
  );
  return res.rows.map((r: { post_id: number }) => r.post_id);
}
