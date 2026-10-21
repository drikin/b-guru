/* ジュークボックス（drikin 2026-10-19）: backspace.fm の過去回をアプリで聴く。
 *
 * - 取り込み: Art19 の公開 RSS（全回、2014 年の #001 から）を 6 時間ごとに podcast_episodes へ。
 *   会員限定の「BSMポッドキャスト」（BSM_FEED_URL、2026-10-21 ドリキン）も 1 時間ごとに系列 "BSM" で。
 *   毎朝の「N 年前の今日」は公開の回からだけ選ぶ。
 * - アプリ: GET /api/agent/jukebox で全回をまとめて返す（1 回数百バイト。検索・絞り込み・
 *   シャッフルは端末で）。機能フラグ JUKEBOX_ALLOW_EMAILS（"*" で全員）。
 * - 毎朝 7 時（日本時間）: 「N 年前の今日の backspace.fm」を 1 本タイムラインへ（全員に見える。
 *   音声は投稿の audio_url に付くので、その場で再生でき、返信がその回の感想スレッドになる）。
 *   止めるときは JUKEBOX_DAILY_POST=0。
 * 単一プロセス（pm2 1 本）前提のタイマー。日付ごとの投稿は jukebox_daily の主キーで 1 本に保つ。 */
import { pool } from "./db";
import { ART19_FEED_URL, BSM_SERIES, clip, jstDay, parseArt19, parseBsmFeed, pickForDay, dailyPostText, yearsAgo, type FeedEpisode } from "./jukebox-feed";

const SYSTEM_EMAIL = "system@backspace.fm";
const SYSTEM_NAME = "ビーグル";
const SYNC_EVERY_MS = 6 * 3600_000;
/** The members' feed gets 即日配信 the same day: read it more often. */
const BSM_SYNC_EVERY_MS = 3600_000;
const TICK_MS = 10 * 60_000;
/** The daily post goes out from this hour (JST). */
const DAILY_HOUR_JST = 7;

export function jukeboxEnabledFor(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.JUKEBOX_ALLOW_EMAILS?.trim();
  if (!raw) return false;
  if (raw === "*") return true;
  return raw.split(",").map((s) => s.trim().toLowerCase()).includes(email.trim().toLowerCase());
}

/** iOS 0.2.16–0.2.20 crash at launch when the jukebox is on (a page inserted into a
 *  paged TabView mid-layout; fixed in 0.2.21). They send "BguruChatMac/0.2.x" — the Mac
 *  app is 0.3.x and never had these numbers. Never tell them it is on. */
export function jukeboxBrokenClient(userAgent: string | null | undefined): boolean {
  return /^BguruChatMac\/0\.2\.(1[6-9]|20)(?![0-9])/.test(userAgent ?? "");
}

// ── 取り込み ─────────────────────────────────────────────────────

type FeedState = { etag?: string; lastModified?: string; syncedAt?: number };
type G = { __jukebox?: FeedState & { bsm?: FeedState; timer?: ReturnType<typeof setInterval>; busy?: boolean } };
const state = () => ((globalThis as G).__jukebox ??= {});

/** Fetch the feed (skipped when unchanged) and upsert every episode. */
export async function syncArchive(fetchImpl: typeof fetch = fetch): Promise<{ changed: boolean; episodes: number }> {
  const st = state();
  const headers: Record<string, string> = { "User-Agent": "B-guru jukebox (+https://bsm.backspace.fm)" };
  if (st.etag) headers["If-None-Match"] = st.etag;
  if (st.lastModified) headers["If-Modified-Since"] = st.lastModified;
  const res = await fetchImpl(ART19_FEED_URL, { headers, cache: "no-store" });
  st.syncedAt = Date.now();
  if (res.status === 304) return { changed: false, episodes: 0 };
  if (!res.ok) throw new Error(`art19 feed ${res.status}`);
  const episodes = parseArt19(await res.text());
  if (episodes.length < 100) throw new Error(`art19 feed looks short (${episodes.length})`); // never wipe on a bad page
  await upsertEpisodes(episodes);
  st.etag = res.headers.get("etag") ?? undefined;
  st.lastModified = res.headers.get("last-modified") ?? undefined;
  return { changed: true, episodes: episodes.length };
}

/** The members-only BSM feed (BSM_FEED_URL). No-op until it is set. Errors never carry
 *  the URL (it must not reach the logs). */
export async function syncBsmFeed(fetchImpl: typeof fetch = fetch): Promise<{ changed: boolean; episodes: number }> {
  const url = process.env.BSM_FEED_URL?.trim();
  if (!url) return { changed: false, episodes: 0 };
  const st = (state().bsm ??= {});
  const headers: Record<string, string> = { "User-Agent": "B-guru jukebox (+https://bsm.backspace.fm)" };
  if (st.etag) headers["If-None-Match"] = st.etag;
  if (st.lastModified) headers["If-Modified-Since"] = st.lastModified;
  let res: Response;
  try {
    res = await fetchImpl(url, { headers, cache: "no-store" });
  } catch {
    throw new Error("bsm feed unreachable");
  }
  st.syncedAt = Date.now();
  if (res.status === 304) return { changed: false, episodes: 0 };
  if (!res.ok) throw new Error(`bsm feed ${res.status}`);
  const episodes = parseBsmFeed(await res.text());
  if (episodes.length === 0) throw new Error("bsm feed has no episodes"); // never act on a bad page
  await upsertEpisodes(episodes);
  st.etag = res.headers.get("etag") ?? undefined;
  st.lastModified = res.headers.get("last-modified") ?? undefined;
  return { changed: true, episodes: episodes.length };
}

/** 「N 年前の今日」 picks only from the public episodes (the post is on the timeline
 *  with the audio attached; BSM 回 stay in the jukebox). */
const publicOnly = <R extends { series: string }>(rows: R[]) => rows.filter((r) => r.series !== BSM_SERIES);

export async function upsertEpisodes(eps: FeedEpisode[]): Promise<void> {
  const col = <K extends keyof FeedEpisode>(k: K) => eps.map((e) => e[k]);
  await pool.query(
    `INSERT INTO podcast_episodes (guid, title, published_at, audio_url, audio_bytes, duration_sec, summary, series, number, web_url)
     SELECT * FROM unnest($1::text[], $2::text[], $3::timestamptz[], $4::text[], $5::bigint[], $6::int[], $7::text[], $8::text[], $9::int[], $10::text[])
     ON CONFLICT (guid) DO UPDATE SET
       title = EXCLUDED.title, published_at = EXCLUDED.published_at, audio_url = EXCLUDED.audio_url,
       audio_bytes = EXCLUDED.audio_bytes, duration_sec = EXCLUDED.duration_sec, summary = EXCLUDED.summary,
       series = EXCLUDED.series, number = EXCLUDED.number, web_url = EXCLUDED.web_url, updated_at = now()
     WHERE (podcast_episodes.title, podcast_episodes.audio_url, podcast_episodes.duration_sec, podcast_episodes.summary)
       IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.audio_url, EXCLUDED.duration_sec, EXCLUDED.summary)`,
    [col("guid"), col("title"), col("publishedAt"), col("audioUrl"), col("audioBytes"), col("durationSec"),
     col("summary"), col("series"), col("number"), col("webUrl")]
  );
}

// ── アプリ向け ───────────────────────────────────────────────────

type Row = {
  id: number; guid: string; title: string; published_at: Date; audio_url: string; audio_bytes: string;
  duration_sec: number | null; summary: string; series: string; number: number | null; web_url: string | null;
};

async function allEpisodes(): Promise<Row[]> {
  const r = await pool.query(
    `SELECT id, guid, title, published_at, audio_url, audio_bytes, duration_sec, summary, series, number, web_url
       FROM podcast_episodes WHERE NOT hidden ORDER BY published_at DESC, id DESC`
  );
  return r.rows;
}

/** One episode for the apps (snake_case like the rest of /api/agent). */
export function toAgentEpisodeDto(r: Row) {
  return {
    id: r.guid,
    title: r.title,
    published_at: new Date(r.published_at).toISOString(),
    audio_url: r.audio_url,
    duration_sec: r.duration_sec,
    series: r.series,
    number: r.number,
    summary: clip(r.summary, 160),
    web_url: r.web_url,
  };
}

/** GET /api/agent/jukebox: every episode (newest first) and today's pick. */
export async function jukeboxForApp() {
  const rows = await allEpisodes();
  const day = jstDay();
  const d = await pool.query(`SELECT episode_id, post_id FROM jukebox_daily WHERE day = $1`, [day]);
  const pickRow = d.rows[0]
    ? rows.find((r) => r.id === d.rows[0].episode_id)
    : pickForDay(publicOnly(rows).map((r) => ({ ...r, publishedAt: new Date(r.published_at).toISOString() })), day);
  return {
    episodes: rows.map(toAgentEpisodeDto),
    today: pickRow
      ? {
          id: pickRow.guid,
          years_ago: yearsAgo(new Date(pickRow.published_at).toISOString(), day),
          post_id: d.rows[0]?.post_id ?? null,
        }
      : null,
  };
}

// ── 毎朝の投稿 ───────────────────────────────────────────────────

/** Post today's "N 年前の今日" once (JST day), from 7:00. Returns the post id when it posted. */
export async function postDailyIfDue(now = new Date()): Promise<number | null> {
  if (process.env.JUKEBOX_DAILY_POST === "0") return null;
  const jstHour = new Date(now.getTime() + 9 * 3600_000).getUTCHours();
  if (jstHour < DAILY_HOUR_JST) return null;
  const day = jstDay(now);
  const done = await pool.query(`SELECT 1 FROM jukebox_daily WHERE day = $1`, [day]);
  if (done.rows.length) return null;
  const rows = publicOnly(await allEpisodes());
  const pick = pickForDay(rows.map((r) => ({ ...r, publishedAt: new Date(r.published_at).toISOString() })), day);
  if (!pick) return null;
  // Claim the day first: a second timer (or a restart mid-way) never posts twice.
  const claim = await pool.query(
    `INSERT INTO jukebox_daily (day, episode_id) VALUES ($1, $2) ON CONFLICT (day) DO NOTHING RETURNING day`,
    [day, pick.id]
  );
  if (!claim.rows.length) return null;
  const text = dailyPostText(
    { title: pick.title, publishedAt: pick.publishedAt, durationSec: pick.duration_sec, summary: pick.summary, webUrl: pick.web_url },
    day
  );
  const ins = await pool.query(
    `INSERT INTO posts (author_email, author_name, text, audio_url, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [SYSTEM_EMAIL, SYSTEM_NAME, text, pick.audio_url]
  );
  const postId: number = ins.rows[0].id;
  await pool.query(`UPDATE jukebox_daily SET post_id = $2 WHERE day = $1`, [day, postId]);
  return postId;
}

/** One process-wide timer (started from instrumentation.ts), like ensureHousekeeping. */
export function ensureJukebox(): void {
  const st = state();
  if (st.timer) return;
  const run = async () => {
    if (st.busy) return;
    st.busy = true;
    try {
      if (!st.syncedAt || Date.now() - st.syncedAt > SYNC_EVERY_MS) {
        const r = await syncArchive();
        if (r.changed) console.log(`[bsm] jukebox: synced ${r.episodes} episodes`);
      }
      const bsm = st.bsm?.syncedAt;
      if (!bsm || Date.now() - bsm > BSM_SYNC_EVERY_MS) {
        const r = await syncBsmFeed().catch((e) => {
          console.error("[bsm] jukebox (BSM feed):", (e as Error)?.message);
          return null;
        });
        if (r?.changed) console.log(`[bsm] jukebox: synced ${r.episodes} BSM episodes`);
      }
      const id = await postDailyIfDue();
      if (id) console.log(`[bsm] jukebox: daily post ${id}`);
    } catch (e) {
      console.error("[bsm] jukebox:", (e as Error)?.message);
    } finally {
      st.busy = false;
    }
  };
  setTimeout(run, 30_000).unref?.(); // not in the way of startup
  st.timer = setInterval(run, TICK_MS);
  st.timer.unref?.();
}
