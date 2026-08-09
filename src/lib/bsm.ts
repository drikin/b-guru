/* Fetch BSM portal content from Ghost (posts tagged `bsm`). */
import crypto from "crypto";

function makeToken(key: string): string {
  const kid = key.split(":", 1)[0];
  const secret = key.slice(key.indexOf(":") + 1);
  const secretBytes = Buffer.from(secret, "hex");
  const header = { kid, typ: "JWT", alg: "HS256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 300, aud: "/admin/" };
  const b64 = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const headerPayload = `${b64(header)}.${b64(payload)}`;
  const sig = crypto
    .createHmac("sha256", secretBytes)
    .update(headerPayload)
    .digest("base64url");
  return `${headerPayload}.${sig}`;
}

export interface BsmEpisode {
  id: string;
  title: string;
  slug: string;
  publishedAt: string;
  visibility: string;
  tags: string[];
  canonicalUrl?: string;
  pageUrl?: string; // public Ghost post URL on backspace.fm
  excerpt?: string;
}

/** Latest BSM episodes (tag:bsm), newest first. Paid content included. */
export async function fetchBsmEpisodes(): Promise<BsmEpisode[]> {
  const base = process.env.GHOST_ADMIN_API_URL!;
  const key = process.env.GHOST_ADMIN_API_KEY!;
  const token = makeToken(key);

  // tag:bsm OR tag:backspacefm (all episodes: BSM-exclusive + regular), newest first
  const url = `${
    base
  }/ghost/api/admin/posts/?filter=tag%3A%5Bbsm%2Cbackspacefm%5D&order=published_at%20desc&limit=50&formats=html`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Ghost ${token}`,
      "Accept-Version": "v6.0",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Ghost posts API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const posts = data.posts ?? [];

  // Exclude maintenance/housekeeping and special tags if wanted; keep all bsm for now
  return posts.map((p: any) => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    publishedAt: p.published_at ?? p.created_at,
    visibility: p.visibility,
    tags: (p.tags ?? []).map((t: any) => t.slug),
    canonicalUrl: p.canonical_url,
    pageUrl: p.url,
    excerpt: p.custom_excerpt ?? p.excerpt ?? undefined,
  }));
}
