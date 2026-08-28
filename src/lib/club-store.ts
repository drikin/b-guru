/* 部活カタログの DB 管理（サーバー専用）。admin が部活ラベルの追加/編集/削除（非表示化）を行う。
 *
 * source of truth を club-catalog.ts（静的 seed）から PostgreSQL の clubs テーブルに移す。
 * - active=false = 「削除」扱い: 左SB一覧・AI分類対象から外すが、既存投稿のラベルは維持（drikin 指定）。
 * - manual=true  = システム予約（雑談/機能改善/バグ報告）。削除不可。
 * 初回起動時は club-catalog.ts の現行カタログを seed する（instrumentation 経由で ensureClubsSeeded）。 */

import { pool } from "./db";
import {
  CLUBS,
  CLUB_UNSET,
  clubCategory,
  type ClubDef,
} from "./club-catalog";

export interface ClubCatalogRow {
  key: string;
  name: string;
  category: string;
  definition: string;
  active: boolean;
  manual: boolean;
  sort: number;
}

const MANUAL_KEYS = ["chat", "improve", "bug"];

/** 空のときだけ現行カタログ(CLUBS + CLUB_CATEGORIES)を seed する（冪等・複数回安全）。 */
export async function ensureClubsSeeded(): Promise<void> {
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM clubs`);
  if ((rows[0] as { n: number }).n > 0) return;
  for (let i = 0; i < CLUBS.length; i++) {
    const c: ClubDef = CLUBS[i];
    await pool.query(
      `INSERT INTO clubs (key, name, category, definition, active, manual, sort)
       VALUES ($1, $2, $3, $4, TRUE, $5, $6)
       ON CONFLICT (key) DO NOTHING`,
      [
        c.key,
        c.name,
        clubCategory(c.key) ?? "その他",
        c.def,
        MANUAL_KEYS.includes(c.key),
        i,
      ]
    );
  }
}

function row(r: any): ClubCatalogRow {
  return { ...r, active: !!r.active, manual: !!r.manual };
}

/** カタログ一覧（activeOnly=true なら active のみ）。sort 順 → key 順。 */
export async function listClubs(
  opts: { activeOnly?: boolean } = {}
): Promise<ClubCatalogRow[]> {
  const activeOnly = opts.activeOnly ?? true;
  const res = await pool.query(
    `SELECT key, name, category, definition, active, manual, sort
       FROM clubs
       ${activeOnly ? "WHERE active = TRUE" : ""}
      ORDER BY sort, key`
  );
  return res.rows.map(row);
}

export async function getClub(key: string): Promise<ClubCatalogRow | null> {
  const res = await pool.query(
    `SELECT key, name, category, definition, active, manual, sort
       FROM clubs WHERE key = $1`,
    [key]
  );
  return res.rows.length ? row(res.rows[0]) : null;
}

/** 手動付け替え用バリデーション: 有効な部活キーか（__unset__ は部活でないので false）。 */
export async function isActiveClubKey(key: string): Promise<boolean> {
  if (key === CLUB_UNSET) return false;
  const res = await pool.query(
    `SELECT 1 FROM clubs WHERE key = $1 AND active = TRUE`,
    [key]
  );
  return res.rows.length > 0;
}

/** 部活を追加（admin）。key 重複は null を返す（呼び出し側で 400/409 判定）。 */
export async function createClub(input: {
  key: string;
  name: string;
  category: string;
  definition: string;
}): Promise<ClubCatalogRow | null> {
  const key = input.key.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(key)) throw new Error("INVALID_KEY");
  if (key === CLUB_UNSET) throw new Error("INVALID_KEY");
  const exists = await getClub(key);
  if (exists) return null;

  const { rows } = await pool.query(
    `SELECT COALESCE(MAX(sort), 0) + 10 AS s FROM clubs`
  );
  const sort = (rows[0] as { s: number }).s;
  const res = await pool.query(
    `INSERT INTO clubs (key, name, category, definition, active, manual, sort)
     VALUES ($1, $2, $3, $4, TRUE, FALSE, $5)
     RETURNING key, name, category, definition, active, manual, sort`,
    [key, input.name.trim(), input.category.trim() || "その他", input.definition.trim(), sort]
  );
  return res.rows.length ? row(res.rows[0]) : null;
}

/** 部活を編集（admin）。提供されたフィールドだけ更新（parameterized）。
 *  active=false（削除）を manual（システム予約）に行うと null を返す。 */
export async function updateClub(
  key: string,
  fields: {
    name?: string;
    category?: string;
    definition?: string;
    active?: boolean;
  }
): Promise<ClubCatalogRow | null> {
  const cur = await getClub(key);
  if (!cur) return null;
  if (fields.active === false && cur.manual) return null; // 予約クラブは削除不可

  const sets: string[] = [];
  const params: unknown[] = [];
  const setName = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col} = $${params.length}`);
  };
  if (fields.name !== undefined) setName("name", fields.name.trim() || cur.name);
  if (fields.category !== undefined)
    setName("category", fields.category.trim() || "その他");
  if (fields.definition !== undefined)
    setName("definition", fields.definition.trim());
  if (fields.active !== undefined) setName("active", fields.active);
  if (sets.length === 0) return cur;
  params.push(key);
  sets.push(`updated_at = now()`);
  const res = await pool.query(
    `UPDATE clubs SET ${sets.join(", ")} WHERE key = $${params.length}
     RETURNING key, name, category, definition, active, manual, sort`,
    params
  );
  return res.rows.length ? row(res.rows[0]) : null;
}
