/* ビーグルエージェント: DB 状態（beagle_state / beagle_log）アクセス */
import { pool } from "../db";
import type { BeagleAction, BeagleDecision, BeagleState } from "./types";

export const SYSTEM_EMAIL = "system@backspace.fm";
export const SYSTEM_NAME = "ビーグル";

function rowToState(r: any): BeagleState {
  const posted: string[] = Array.isArray(r.posted_news) ? r.posted_news : [];
  const responded: number[] = Array.isArray(r.responded_posts)
    ? (r.responded_posts as unknown[])
        .map((n) => Number(n))
        .filter((n) => !isNaN(n))
    : [];
  return {
    lastTickAt: r.last_tick_at ? new Date(r.last_tick_at).toISOString() : null,
    nextActivityAt: r.next_activity_at ? new Date(r.next_activity_at).toISOString() : null,
    enabled: !!r.enabled,
    memoryBytes: Number(r.memory_bytes) || 0,
    postedNews: posted,
    respondedPosts: responded,
  };
}

/** beagle_state（id=1）を取得。無ければ既定行を作成。 */
export async function getState(): Promise<BeagleState> {
  await pool.query(`INSERT INTO beagle_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  const res = await pool.query(`SELECT * FROM beagle_state WHERE id = 1`);
  return rowToState(res.rows[0]);
}

/** state の一部を更新。 */
export async function updateState(
  patch: Partial<BeagleState & { nextActivityAtRaw?: Date; lastTickAtRaw?: Date }>
): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (patch.lastTickAt != null) add("last_tick_at", patch.lastTickAt);
  if (patch.lastTickAtRaw) add("last_tick_at", patch.lastTickAtRaw);
  if (patch.nextActivityAt != null) add("next_activity_at", patch.nextActivityAt);
  if (patch.nextActivityAtRaw) add("next_activity_at", patch.nextActivityAtRaw);
  if (typeof patch.enabled === "boolean") add("enabled", patch.enabled);
  if (typeof patch.memoryBytes === "number") add("memory_bytes", patch.memoryBytes);
  if (patch.postedNews) add("posted_news", JSON.stringify(patch.postedNews));
  if (patch.respondedPosts) add("responded_posts", JSON.stringify(patch.respondedPosts));
  if (sets.length === 0) return;
  await pool.query(`UPDATE beagle_state SET ${sets.join(", ")} WHERE id = 1`, vals);
}

/** 既に返信/反応した投稿IDを記録（重複返信防止用・最新200件を保持）。 */
export async function markResponded(ids: number[]): Promise<void> {
  const uniq = [...new Set(ids.map(Number).filter((n) => !isNaN(n) && n > 0))];
  if (uniq.length === 0) return;
  const state = await getState();
  const merged = [...new Set([...state.respondedPosts, ...uniq])].slice(-200);
  await updateState({ respondedPosts: merged });
}

/** 返信先 postId のルート投稿IDを解決（自分の投稿への再反応防止で使う）。 */
export async function resolveRoot(postId: number): Promise<number> {
  let cur = postId;
  const seen = new Set<number>();
  let guard = 0;
  while (guard++ < 20 && !seen.has(cur)) {
    seen.add(cur);
    const res = await pool.query(`SELECT parent_id FROM posts WHERE id = $1`, [cur]);
    if (res.rows.length === 0 || res.rows[0].parent_id == null) return cur;
    cur = (res.rows[0].parent_id as number) ?? cur;
  }
  return cur;
}

/** ログに1行追記。 */
export async function appendBeagleLog(entry: {
  mode: "dry" | "live";
  intent?: string;
  decision?: BeagleDecision | null;
  actions?: BeagleAction[];
  postedIds?: number[];
  nextActivityAt?: string | null;
  error?: string;
  memoryBytesBefore?: number;
  memoryBytesAfter?: number;
}): Promise<number> {
  const res = await pool.query(
    `INSERT INTO beagle_log
       (mode, intent, decision, actions, posted_ids, next_activity_at, error, memory_bytes_before, memory_bytes_after)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id`,
    [
      entry.mode,
      entry.intent ?? null,
      entry.decision ? JSON.stringify(entry.decision) : null,
      JSON.stringify(entry.actions ?? []),
      entry.postedIds ?? [],
      entry.nextActivityAt ?? null,
      entry.error ?? null,
      entry.memoryBytesBefore ?? 0,
      entry.memoryBytesAfter ?? 0,
    ]
  );
  return (res.rows[0] as { id: number }).id;
}

/** 今日(Japan時)にビーグルが投稿した件数。 */
export async function countBeaglePostsToday(): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS n FROM posts
      WHERE author_email = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`,
    [SYSTEM_EMAIL]
  );
  return (res.rows[0] as { n: number }).n ?? 0;
}

/** ビーグルが最後に投稿（root/reply）してから経過したミリ秒。無ければ Infinity。 */
export async function lastBeaglePostAgoMs(): Promise<number> {
  const res = await pool.query(
    `SELECT MAX(created_at) AS m FROM posts WHERE author_email = $1`,
    [SYSTEM_EMAIL]
  );
  const t = (res.rows[0] as { m: Date | null | undefined }).m;
  if (!t) return Infinity;
  return Date.now() - new Date(t).getTime();
}

/** 直近のビーグルによる投稿ID（言及の返信先などを除外判定等で使う）。 */
export async function getBeaglePostIds(lastHours = 96): Promise<number[]> {
  const res = await pool.query(
    `SELECT id FROM posts WHERE author_email = $1 AND created_at >= now() - interval '${lastHours} hours'`,
    [SYSTEM_EMAIL]
  );
  return (res.rows as { id: number }[]).map((r) => r.id);
}
