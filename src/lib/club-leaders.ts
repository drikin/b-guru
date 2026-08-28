import { pool } from "./db";
import { resolveDisplayNames } from "./display-name";
import { gravatarUrl } from "./posts";

export interface ClubLeader {
  club: string;
  email: string;
  name: string | null;
  avatar: string;
}

/**
 * 部活「部長」の一覧を、表示名 + アバター付きで返す（club → ClubLeader）。
 * 部長が未設定のクラブは含めない。権限チェックは行わない（呼び出し側で要ログイン）。
 */
export async function getClubLeaders(): Promise<Record<string, ClubLeader>> {
  const res = await pool.query(
    `SELECT club, email FROM club_leaders WHERE email IS NOT NULL AND length(btrim(email)) > 0`
  );
  const rows = res.rows as { club: string; email: string }[];
  if (rows.length === 0) return {};

  const names = await resolveDisplayNames(rows.map((r) => r.email));
  const out: Record<string, ClubLeader> = {};
  for (const r of rows) {
    out[r.club] = {
      club: r.club,
      email: r.email,
      name: names.get(r.email) ?? null,
      avatar: gravatarUrl(r.email),
    };
  }
  return out;
}

/** 部長を設定/解除する（email=null で解除）。@return 設定後の ClubLeader（解除は null）。 */
export async function setClubLeader(
  club: string,
  email: string | null
): Promise<ClubLeader | null> {
  if (email) {
    await pool.query(
      `INSERT INTO club_leaders (club, email, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (club) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
      [club, email]
    );
    const name = (await resolveDisplayNames([email])).get(email) ?? null;
    return { club, email, name, avatar: gravatarUrl(email) };
  }
  await pool.query(`DELETE FROM club_leaders WHERE club = $1`, [club]);
  return null;
}
