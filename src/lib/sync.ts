/* Auto-post new episodes from Ghost into the feed.
 * Called by a daily cron job. Idempotent via source_ghost_id. */
import { fetchBsmEpisodes, BsmEpisode } from "./bsm";
import { pool } from "./db";

const SYSTEM_EMAIL = "system@backspace.fm";
const SYSTEM_NAME = "ビーグル";

/**
 * Check Ghost for new episodes and insert them into the feed.
 * Returns the number of newly posted episodes.
 */
export async function syncNewEpisodes(): Promise<{
  posted: number;
  scanned: number;
}> {
  const episodes = await fetchBsmEpisodes();
  let posted = 0;

  for (const ep of episodes) {
    // Skip posts that are not yet published (draft/pending)
    if (ep.publishedAt && new Date(ep.publishedAt).getTime() > Date.now() + 60000) {
      continue;
    }

    const already = await pool.query(
      `SELECT 1 FROM posts WHERE source_ghost_id = $1`,
      [ep.id]
    );
    if (already.rows.length > 0) {
      // Backfill: correct created_at to the real publish date (fixes ordering)
      if (ep.publishedAt) {
        await pool.query(
          `UPDATE posts SET created_at = $1 WHERE source_ghost_id = $2`,
          [new Date(ep.publishedAt), ep.id]
        );
      }
      continue;
    }

    const text = buildEpisodeText(ep);
    await pool.query(
      `INSERT INTO posts (author_email, author_name, text, url_preview, source_ghost_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        SYSTEM_EMAIL,
        SYSTEM_NAME,
        text,
        JSON.stringify({ url: ep.pageUrl }),
        ep.id,
        // use real episode publish time so the feed sorts chronologically
        ep.publishedAt ? new Date(ep.publishedAt) : new Date(),
      ]
    );
    posted++;
  }

  return { posted, scanned: episodes.length };
}

function buildEpisodeText(ep: BsmEpisode): string {
  const prefix = ep.tags.includes("bsm") ? "🎧 [BSM] 新エピソード" : "🎧 新エピソード";
  const url = ep.pageUrl || "";
  return `${prefix}: ${ep.title}${url ? `\n${url}` : ""}`;
}
