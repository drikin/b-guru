import { pool } from "./db";
import { resolveDisplayNames } from "./display-name";
import { gravatarUrl } from "./posts";

export interface ClubLeader {
  club: string;
  email: string;
  name: string | null;
  avatar: string;
  headerImage: string | null;
  bio: string | null;
}

/** 部長のメール一覧から user_profiles のヘッダー画像と bio をまとめて取得する（無ければ null）。 */
async function profileChunks(
  emails: string[]
): Promise<Map<string, { headerImage: string | null; bio: string | null }>> {
  const out = new Map<string, { headerImage: string | null; bio: string | null }>();
  if (emails.length === 0) return out;
  const res = await pool.query(
    `SELECT email, header_image, bio FROM user_profiles WHERE email = ANY($1::text[])`,
    [emails]
  );
  for (const r of res.rows as {
    email: string;
    header_image: string | null;
    bio: string | null;
  }[]) {
    out.set(r.email, {
      headerImage: r.header_image && r.header_image.trim() ? r.header_image.trim() : null,
      bio: r.bio && r.bio.trim() ? r.bio : null,
    });
  }
  return out;
}

/**
 * 部活「部長」の一覧を、表示名 + アバター + プロフィール背景 + 自己紹介付きで返す（club → ClubLeader）。
 * 部長が未設定のクラブは含めない。権限チェックは行わない（呼び出し側で要ログイン）。
 */
export async function getClubLeaders(): Promise<Record<string, ClubLeader>> {
  const res = await pool.query(
    `SELECT club, email FROM club_leaders WHERE email IS NOT NULL AND length(btrim(email)) > 0`
  );
  const rows = res.rows as { club: string; email: string }[];
  if (rows.length === 0) return {};

  const emails = rows.map((r) => r.email);
  const names = await resolveDisplayNames(emails);
  const profs = await profileChunks(emails);
  const out: Record<string, ClubLeader> = {};
  for (const r of rows) {
    const p = profs.get(r.email) ?? { headerImage: null, bio: null };
    out[r.club] = {
      club: r.club,
      email: r.email,
      name: names.get(r.email) ?? null,
      avatar: gravatarUrl(r.email),
      headerImage: p.headerImage,
      bio: p.bio,
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
    const p = (await profileChunks([email])).get(email) ?? {
      headerImage: null,
      bio: null,
    };
    return {
      club,
      email,
      name,
      avatar: gravatarUrl(email),
      headerImage: p.headerImage,
      bio: p.bio,
    };
  }
  await pool.query(`DELETE FROM club_leaders WHERE club = $1`, [club]);
  return null;
}
