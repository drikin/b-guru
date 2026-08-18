/**
 * User profile timeline support.
 *
 * Profile info is stored in `user_profiles` (keyed by posts.author_email).
 * display_name / bio / header_image / links are optional — everything falls
 * back gracefully: name → latest posts.author_name → email local part,
 * avatar → Gravatar (no custom avatar field), header/bio/links → hidden.
 *
 * Pure validation logic (validateLinks / validateHeaderImage) lives here so it
 * can be unit-tested without a DB, following the feed.ts pattern.
 */
import { pool } from "./db";
import { gravatarUrl } from "./posts";

export interface ProfileLink {
  label: string;
  href: string;
}

export interface Profile {
  email: string;
  name: string;
  avatar: string;
  bio: string;
  headerImage: string | null;
  links: ProfileLink[];
  postCount: number;
  firstPostAt: string | null;
}

export const MAX_BIO = 2000;
export const MAX_LINKS = 5;
export const MAX_LINK_LABEL = 40;
export const HEADER_IMAGE_RE = /^\/api\/media\/[^/]+$/;

/** Validate the profile links array. Pure — safe to unit test. */
export function validateLinks(
  links: unknown
): { ok: true; links: ProfileLink[] } | { ok: false; error: string } {
  if (!Array.isArray(links)) return { ok: false, error: "リンクは配列で指定してください" };
  if (links.length > MAX_LINKS) return { ok: false, error: `リンクは最大${MAX_LINKS}件までです` };
  const out: ProfileLink[] = [];
  for (let i = 0; i < links.length; i++) {
    const l = links[i] as Record<string, unknown> | null;
    const label = typeof l?.label === "string" ? l.label.trim() : "";
    const href = typeof l?.href === "string" ? l.href.trim() : "";
    if (!href) continue;
    if (label.length > MAX_LINK_LABEL) {
      return { ok: false, error: "リンク名は40文字以内で指定してください" };
    }
    if (!/^https?:\/\//.test(href) && !HEADER_IMAGE_RE.test(href)) {
      return { ok: false, error: "リンクURLは http(s) または /api/media/ で始めてください" };
    }
    out.push({ label: label || href, href });
  }
  return { ok: true, links: out };
}

/** Validate a header image value. Empty/null is fine (no banner). Pure. */
export function validateHeaderImage(
  headerImage: unknown
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (headerImage == null || headerImage === "") return { ok: true, value: null };
  if (typeof headerImage !== "string") return { ok: false, error: "ヘッダー画像の形式が不正です" };
  const v = headerImage.trim();
  if (!HEADER_IMAGE_RE.test(v) && !/^https:\/\//.test(v)) {
    return { ok: false, error: "ヘッダー画像はアップロードされた画像を指定してください" };
  }
  return { ok: true, value: v };
}

interface ProfileRow {
  display_name: string | null;
  bio: string | null;
  header_image: string | null;
  links: unknown;
}

/** Load a user profile with all fallbacks applied. Returns null only when the
 *  email has neither a profile row nor any root posts. */
export async function getProfile(email: string): Promise<Profile | null> {
  const [rowRes, aggRes] = await Promise.all([
    pool.query(`SELECT display_name, bio, header_image, links FROM user_profiles WHERE email = $1`, [email]),
    pool.query(
      `SELECT author_name AS name,
              COUNT(*)::int AS post_count,
              MIN(created_at) AS first_post_at
       FROM posts
       WHERE author_email = $1 AND parent_id IS NULL
       GROUP BY author_email, author_name`,
      [email]
    ),
  ]);
  const r: ProfileRow | null = rowRes.rows[0] ?? null;
  const a = aggRes.rows[0] ?? null;
  if (!r && !a) return null;

  const rawLinks: ProfileLink[] = r ? (validateLinks(r.links).ok ? (r.links as ProfileLink[]) : []) : [];
  const safeLinks: ProfileLink[] = rawLinks
    .filter((l) => l && typeof l.href === "string")
    .map((l) => ({ label: l.label || l.href, href: l.href }));

  return {
    email,
    name: r?.display_name?.trim() || a?.name || email.split("@")[0],
    avatar: gravatarUrl(email),
    bio: r?.bio?.trim() ?? "",
    headerImage: r?.header_image || null,
    links: safeLinks,
    postCount: a?.post_count ?? 0,
    firstPostAt: a?.first_post_at?.toISOString ? a.first_post_at.toISOString() : a?.first_post_at ?? null,
  };
}

export interface ProfilePatch {
  displayName?: string;
  bio?: string;
  headerImage?: unknown;
  links?: unknown;
}

/** Upsert a user's profile. The client sends the FULL desired profile state
 *  (empty fields = cleared). Throws with a human-readable message on invalid
 *  input. Returns the freshly resolved profile. */
export async function updateProfile(email: string, patch: ProfilePatch): Promise<Profile> {
  const displayName = (patch.displayName ?? "").toString().trim();
  const bio = (patch.bio ?? "").toString().trim();
  if (bio.length > MAX_BIO) throw new Error(`自己紹介は${MAX_BIO}文字以内で指定してください`);

  const header = validateHeaderImage(patch.headerImage);
  if (!header.ok) throw new Error(header.error);

  const links = validateLinks(patch.links ?? []);
  if (!links.ok) throw new Error(links.error);

  await pool.query(
    `INSERT INTO user_profiles (email, display_name, bio, header_image, links, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (email) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       bio = EXCLUDED.bio,
       header_image = EXCLUDED.header_image,
       links = EXCLUDED.links,
       updated_at = now()`,
    [email, displayName || null, bio || null, header.value, JSON.stringify(links.links)]
  );
  return (await getProfile(email))!;
}
