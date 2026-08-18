/* ビーグルエージェント: タイムライン観測（空気を読むための信号） */
import { pool } from "../db";
import { SYSTEM_EMAIL } from "./store";
import type { BeagleTimelineSignal } from "./types";

/** 賑わい・孤立ポスト・ホットスレッド・ビーグルへの言及を取得。
 *  responded: ビーグルが既に返信/反応した投稿ID（重複返信防止）。 */
export async function buildTimelineSignal(responded: Set<number>): Promise<BeagleTimelineSignal> {
  // 直近60分の投稿数
  const act = await pool.query(
    `SELECT COUNT(*)::int AS n FROM posts WHERE created_at >= now() - interval '60 minutes'`
  );
  const activityLastHour = (act.rows[0] as { n: number }).n ?? 0;

  // 直近7日・時間帯ごとの平均（JST でなくても比としては一応使える）
  const avg = await pool.query(
    `SELECT COALESCE(AVG(c), 0)::float AS a FROM (
       SELECT date_trunc('hour', created_at) AS h, COUNT(*)::int AS c
       FROM posts WHERE created_at >= now() - interval '7 days'
       GROUP BY date_trunc('hour', created_at)
     ) x`
  );
  const activityAvgHour = (avg.rows[0] as { a: number }).a ?? 0;
  const trajectory: "up" | "flat" | "down" =
    activityLastHour > activityAvgHour * 1.5
      ? "up"
      : activityLastHour < activityAvgHour * 0.5
      ? "down"
      : "flat";

  // 孤立ポスト: 直近24h・返信0・ビーグル除く
  const orphan = await pool.query(
    `SELECT p.id, COALESCE(p.author_name,'') AS author, left(p.text, 160) AS text
       FROM posts p
      WHERE p.parent_id IS NULL
        AND p.created_at >= now() - interval '24 hours'
        AND p.author_email <> $1
        AND NOT EXISTS (SELECT 1 FROM posts r WHERE r.parent_id = p.id)
      ORDER BY p.created_at DESC LIMIT 5`,
    [SYSTEM_EMAIL]
  );

  // ホットスレッド: 直近48h・コメント>=2
  const hot = await pool.query(
    `SELECT p.id, COALESCE(p.author_name,'') AS author, left(p.text,160) AS text,
            (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id)::int AS cc
       FROM posts p
      WHERE p.parent_id IS NULL
        AND p.created_at >= now() - interval '48 hours'
        AND (SELECT COUNT(*) FROM posts r WHERE r.parent_id = p.id) >= 2
      ORDER BY cc DESC LIMIT 5`
  );

  // 言及: 直近24h・「ビーグル」を含む / ビーグル投稿への返信
  const men = await pool.query(
    `SELECT p.id, p.parent_id, COALESCE(p.author_name,'') AS author, left(p.text,200) AS text
       FROM posts p
      WHERE p.created_at >= now() - interval '24 hours'
        AND p.author_email <> $1
        AND (p.text ILIKE '%ビーグル%' OR p.parent_id IN (
               SELECT id FROM posts WHERE author_email = $1
             ))
      ORDER BY p.created_at DESC LIMIT 10`,
    [SYSTEM_EMAIL]
  );

  return {
    activityLastHour,
    activityAvgHour,
    trajectory,
    // 既に反応済みの投稿/スレッドは除外（重複返信防止）
    orphanPosts: (orphan.rows as { id: number; author: string; text: string }[])
      .filter((r) => !responded.has(r.id))
      .map((r) => ({ id: r.id, author: r.author, text: r.text })),
    hotThreads: (hot.rows as { id: number; author: string; text: string; cc: number }[])
      .filter((r) => !responded.has(r.id))
      .map((r) => ({ id: r.id, author: r.author, text: r.text, commentCount: r.cc })),
    // 言及は「既に返信済みの投稿」だけ除外（新しい言及には必ず対応）
    mentions: (men.rows as { id: number; parent_id: number | null; author: string; text: string }[])
      .filter((r) => !responded.has(r.id))
      .map((r) => ({ id: r.id, parentId: r.parent_id, author: r.author, text: r.text })),
  };
}

/** 直近のタイムライン本文（決定の文脈用）。root+reply を新しい順。 */
export async function getRecentTimeline(limit = 8): Promise<string[]> {
  const res = await pool.query(
    `SELECT COALESCE(author_name,'') AS author, text, created_at
       FROM posts
      WHERE length(trim(text)) > 0
      ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return (res.rows as { author: string; text: string; created_at: Date }[]).map(
    (r) => `${r.author}: ${r.text.slice(0, 140)}`
  );
}

/** lastTickAt 以降の「ビーグルへの新規言及」数（メンション高速レスポンス判定用）。
 *  ビーグル自身の投稿は除外し、自己発火を防ぐ。 */
export async function countNewMentions(sinceIso: string | null): Promise<number> {
  const since = sinceIso ? new Date(sinceIso) : new Date(0);
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM posts
      WHERE created_at > $1 AND author_email <> $2
        AND (text ILIKE '%ビーグル%'
             OR parent_id IN (SELECT id FROM posts WHERE author_email = $2))`,
    [since, SYSTEM_EMAIL]
  );
  return (res.rows[0] as { n: number }).n ?? 0;
}
