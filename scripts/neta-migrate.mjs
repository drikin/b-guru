/**
 * 📝 ネタ帳（Netaspace, neta.backspace.fm）のデータを B-guru の neta_ 表へ写す（docs/neta-integration-plan.md）。
 *
 * 使い方（VPS 上で。接続先は環境変数で渡す。値はシェルの履歴やログに残さない）:
 *   NETA_SRC_DATABASE_URL=<Netaspace の DB> DATABASE_URL=<B-guru の DB> node scripts/neta-migrate.mjs --dry-run
 *   NETA_SRC_DATABASE_URL=<Netaspace の DB> DATABASE_URL=<B-guru の DB> node scripts/neta-migrate.mjs
 *
 * - 移行元は読むだけ（SELECT だけ）。書くのは B-guru の neta_weeks / neta_topics / neta_comments / neta_scripts。
 * - 何度流しても同じ結果（id で上書き）。切り替えの日まで、手元や本番で何度でもやり直せる。
 * - 「聞きたい」は人に紐付いていないので、話題ごとの数だけ legacy_stars に入れる（stars 表を数える。
 *   topics.stars の列は使われておらず 0 のまま）。fingerprint・Bluesky のセッション・旧管理者の表は写さない。
 * - Netaspace の時刻は timestamp without time zone で UTC（DB の now()）。UTC として読む。
 * - neta_votes（新しい票）には触らない。
 * - B-guru の表は initSchema が作る（先にアプリを一度起動しておく）。
 */
import { Pool } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const SRC = process.env.NETA_SRC_DATABASE_URL;
const DST = process.env.DATABASE_URL;
if (!SRC || !DST) {
  console.error("NETA_SRC_DATABASE_URL と DATABASE_URL を渡してください");
  process.exit(2);
}
if (SRC === DST) {
  console.error("移行元と移行先が同じです");
  process.exit(2);
}

const src = new Pool({ connectionString: SRC, max: 2 });
const dst = new Pool({ connectionString: DST, max: 2 });

async function main() {
  const weeks = (await src.query(
    `SELECT id, title, start_date, end_date, is_active, live_recording_date, live_url FROM weeks ORDER BY id`
  )).rows;
  const topics = (await src.query(
    `SELECT t.id, t.week_id, t.title, t.url, t.description, t.submitter, t.bluesky_handle, t.status,
            t.created_at AT TIME ZONE 'UTC' AS created_at, t.featured_at AT TIME ZONE 'UTC' AS featured_at,
            (SELECT count(*)::int FROM stars s WHERE s.topic_id = t.id) AS legacy_stars
       FROM topics t WHERE t.week_id IS NOT NULL ORDER BY t.id`
  )).rows;
  const orphan = (await src.query(`SELECT count(*)::int AS n FROM topics WHERE week_id IS NULL`)).rows[0].n;
  const comments = (await src.query(
    `SELECT c.id, c.topic_id, c.commenter, c.bluesky_handle, c.content, c.created_at AT TIME ZONE 'UTC' AS created_at
       FROM comments c JOIN topics t ON t.id = c.topic_id WHERE t.week_id IS NOT NULL ORDER BY c.id`
  )).rows;
  // 1 週に 1 つ（同じ週に複数あれば新しいもの）。
  const scripts = (await src.query(
    `SELECT DISTINCT ON (week_id) week_id, content, updated_by, updated_at AT TIME ZONE 'UTC' AS updated_at
       FROM scripts WHERE week_id IS NOT NULL ORDER BY week_id, updated_at DESC`
  )).rows;
  const stars = topics.reduce((a, t) => a + t.legacy_stars, 0);
  const active = weeks.filter((w) => w.is_active);
  console.log(`移行元: 週 ${weeks.length}（今週 ${active.map((w) => w.title).join(", ") || "なし"}）、話題 ${topics.length}（週なし ${orphan} は除く）、聞きたい ${stars}、コメント ${comments.length}、台本 ${scripts.length}`);
  if (active.length > 1) throw new Error("今週が 2 つ以上あります");
  if (DRY_RUN) {
    console.log("--dry-run: 書き込みはしません");
    return;
  }

  const c = await dst.connect();
  try {
    await c.query("BEGIN");
    // 今週の印は 1 つだけ（一意の索引）。先に全部外してから入れ直す。
    await c.query(`UPDATE neta_weeks SET is_active = false WHERE is_active`);
    for (const w of weeks) {
      await c.query(
        `INSERT INTO neta_weeks (id, title, start_date, end_date, is_active, live_recording_date, live_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
           is_active=EXCLUDED.is_active, live_recording_date=EXCLUDED.live_recording_date, live_url=EXCLUDED.live_url`,
        [w.id, w.title, w.start_date, w.end_date, w.is_active, w.live_recording_date, w.live_url]
      );
    }
    for (const t of topics) {
      await c.query(
        `INSERT INTO neta_topics (id, week_id, title, url, description, submitter, bluesky_handle, status, legacy_stars, featured_at, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO UPDATE SET week_id=EXCLUDED.week_id, title=EXCLUDED.title, url=EXCLUDED.url,
           description=EXCLUDED.description, submitter=EXCLUDED.submitter, bluesky_handle=EXCLUDED.bluesky_handle,
           status=EXCLUDED.status, legacy_stars=EXCLUDED.legacy_stars, featured_at=EXCLUDED.featured_at, created_at=EXCLUDED.created_at`,
        [t.id, t.week_id, t.title, t.url, t.description, t.submitter, t.bluesky_handle, t.status, t.legacy_stars, t.featured_at, t.created_at]
      );
    }
    for (const m of comments) {
      await c.query(
        `INSERT INTO neta_comments (id, topic_id, commenter, bluesky_handle, body, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE SET topic_id=EXCLUDED.topic_id, commenter=EXCLUDED.commenter,
           bluesky_handle=EXCLUDED.bluesky_handle, body=EXCLUDED.body, created_at=EXCLUDED.created_at`,
        [m.id, m.topic_id, m.commenter, m.bluesky_handle, m.content, m.created_at]
      );
    }
    for (const s of scripts) {
      await c.query(
        `INSERT INTO neta_scripts (week_id, content, updated_by, updated_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (week_id) DO UPDATE SET content=EXCLUDED.content, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
        [s.week_id, s.content, s.updated_by, s.updated_at]
      );
    }
    // id を持ち込んだので、次に B-guru で作る行が重ならないよう連番を進める。
    for (const tbl of ["neta_weeks", "neta_topics", "neta_comments"]) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${tbl}', 'id'), GREATEST((SELECT COALESCE(max(id), 0) FROM ${tbl}), 1))`);
    }
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
  const after = (await dst.query(
    `SELECT (SELECT count(*) FROM neta_weeks)::int AS w, (SELECT count(*) FROM neta_topics)::int AS t,
            (SELECT COALESCE(sum(legacy_stars),0) FROM neta_topics)::int AS s, (SELECT count(*) FROM neta_comments)::int AS c,
            (SELECT count(*) FROM neta_scripts)::int AS sc`
  )).rows[0];
  console.log(`移行先: 週 ${after.w}、話題 ${after.t}、聞きたい（昔の票）${after.s}、コメント ${after.c}、台本 ${after.sc}`);
}

main()
  .catch((e) => {
    console.error("失敗:", e.message);
    process.exitCode = 1;
  })
  .finally(() => Promise.all([src.end(), dst.end()]));
