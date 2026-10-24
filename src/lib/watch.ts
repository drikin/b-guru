/* 📺 YouTube 共同鑑賞（オーナー決定 2026-10-25）: チャットの部室で 1 本の動画をみんなで同時に見る。
 *   - 操作は誰でも（再生・一時停止・シーク・動画の変更・見たいものリスト）。最初から全員（WATCH_ENABLED は止めるためのスイッチ）
 *   - 状態は 1 行（watch_state）: 今の動画・再生中か・位置（updated_at の時点の秒）・版。見たいものリストは watch_queue（30 本まで）
 *   - 変えるたびに版 +1 し、即時の知らせ { type: "watch", state } で全員へ。各端末は「位置 ＋ 経過時間」に合わせる
 *     （プレイヤーのページ public/watch/ が合わせる。アプリと Web はページの操作を API へ中継するだけ）
 *   - 動画の確かめ: ID の形（11 文字）と YouTube の oEmbed（鍵なし）。埋め込めない動画は oEmbed が 401/403/404
 *   - 終わった・再生できない（ページが報告）は、版と動画が今のものと同じときだけ次へ（何台から届いても 1 回）
 *   - 動画を流し始めたらチャットに 1 行（2 分以内の次の動画はその行を書き換える）
 *   - 6 時間だれも触らなければ、次に読まれたときに片付ける
 * 行には users.user_id だけを持つ（メールは持たない・知らせにも載せない）。 */
import { pool } from "./db";
import { emitLive } from "./live";
import { featureEnabledFor } from "./feature-flag";
import { playersOf } from "./shogi";
import { postChatNotice } from "./chat";
import { extractYoutubeId } from "./urlpreview";

export const WATCH_FLAG = "WATCH_ENABLED";
export const QUEUE_MAX = 30;
export const IDLE_MS = 6 * 60 * 60 * 1000;
export const NOTICE_MERGE_MS = 2 * 60 * 1000;
const MAX_POSITION_S = 24 * 60 * 60;
const LOCK_KEY = 4747101;

export function watchEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor(WATCH_FLAG, email);
}

/** プレイヤーが読む YouTube（あとで youtube-nocookie に替えられるように、アプリを出し直さずサーバで決める）。 */
export function watchYoutubeHost(): string {
  const h = process.env.WATCH_YT_HOST;
  return h === "www.youtube-nocookie.com" ? h : "www.youtube.com";
}

export class WatchError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = { email: string; userId: string };

export type WatchVideoDto = {
  video_id: string;
  title: string;
  channel: string | null;
  by: string | null;
};
export type WatchQueueItemDto = WatchVideoDto & { id: number };
export type WatchStateDto = {
  version: number;
  video: WatchVideoDto | null;
  playing: boolean;
  /** `updated_at` の時点の位置（秒）。再生中なら今の位置は position + (今 − updated_at)。 */
  position: number;
  /** ミリ秒（サーバの時計）。 */
  updated_at: number;
  /** この状態を作った時のサーバの時計（ミリ秒）。端末の時計とのずれを測る。 */
  server_now: number;
  /** 最後の操作（「〇〇さんが一時停止」の表示用）。 */
  last: { by: string | null; action: string } | null;
  queue: WatchQueueItemDto[];
  youtube_host: string;
};

/** 動画の ID: URL（watch・shorts・youtu.be・embed・live）か、ID そのもの。 */
export function parseVideoId(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  if (s.length > 2048) return null;
  const id = extractYoutubeId(s);
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function clampPosition(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_POSITION_S, Math.round(n * 10) / 10));
}

// ───────────────────────────────── 動画の確かめ（oEmbed）

type VideoInfo = { title: string; channel: string | null };
const infoCache = new Map<string, { at: number; info: VideoInfo }>();
const INFO_CACHE_MS = 60 * 60 * 1000;

/** テストで差し替える。 */
export let fetchImpl: typeof fetch = (...a) => fetch(...a);
export function _setFetchForTest(f: typeof fetch | null): void {
  fetchImpl = f ?? ((...a) => fetch(...a));
  infoCache.clear();
}

/** タイトルとチャンネル。埋め込めない（非公開・削除・埋め込み不可）なら WatchError。YouTube に届かないときは仮の題で通す。 */
export async function videoInfo(videoId: string): Promise<VideoInfo> {
  const hit = infoCache.get(videoId);
  if (hit && Date.now() - hit.at < INFO_CACHE_MS) return hit.info;
  let res: Response;
  try {
    res = await fetchImpl(
      `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "B-guru (bsm.backspace.fm)" },
      },
    );
  } catch {
    return { title: "YouTube の動画", channel: null };
  }
  if (
    res.status === 401 ||
    res.status === 403 ||
    res.status === 404 ||
    res.status === 400
  ) {
    throw new WatchError(
      422,
      "not_embeddable",
      "この動画はここでは再生できません（非公開・削除・埋め込み不可）",
    );
  }
  if (!res.ok) return { title: "YouTube の動画", channel: null };
  let j: Record<string, unknown> = {};
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 題がなくても見られる */
  }
  const info: VideoInfo = {
    title:
      typeof j.title === "string" && j.title.trim()
        ? j.title.trim().slice(0, 200)
        : "YouTube の動画",
    channel:
      typeof j.author_name === "string" && j.author_name.trim()
        ? j.author_name.trim().slice(0, 100)
        : null,
  };
  // 古いものを捨て、多くても 1000 本まで（連打よけの枠の中でも増え続けないように）。
  if (infoCache.size >= 1000) {
    const now = Date.now();
    for (const [k, v] of infoCache) if (now - v.at >= INFO_CACHE_MS) infoCache.delete(k);
    while (infoCache.size >= 1000) infoCache.delete(infoCache.keys().next().value as string);
  }
  infoCache.set(videoId, { at: Date.now(), info });
  return info;
}

// ───────────────────────────────── 状態

type StateRow = {
  video_id: string | null;
  title: string | null;
  channel: string | null;
  started_by: string | null;
  playing: boolean;
  position_s: number;
  updated_at: Date;
  version: number;
  last_actor: string | null;
  last_action: string | null;
  notice_msg_id: number | null;
  notice_at: Date | null;
  notice_text: string | null;
};
type QueueRow = {
  id: number;
  video_id: string;
  title: string;
  channel: string | null;
  added_by: string;
};
type Db = Pick<typeof pool, "query">;

async function readRows(db: Db): Promise<{ s: StateRow; q: QueueRow[] }> {
  await db.query(
    `INSERT INTO watch_state (id) VALUES (1) ON CONFLICT DO NOTHING`,
  );
  const s = (await db.query(`SELECT * FROM watch_state WHERE id = 1`))
    .rows[0] as StateRow;
  const q = (
    await db.query(
      `SELECT id, video_id, title, channel, added_by FROM watch_queue ORDER BY id`,
    )
  ).rows as QueueRow[];
  return { s, q };
}

async function toDto(
  s: StateRow,
  q: QueueRow[],
  now = Date.now(),
): Promise<WatchStateDto> {
  const names = await playersOf([
    s.started_by,
    s.last_actor,
    ...q.map((x) => x.added_by),
  ]);
  const nameOf = (u: string | null) =>
    u ? (names.get(u)?.name ?? null) : null;
  return {
    version: s.version,
    video: s.video_id
      ? {
          video_id: s.video_id,
          title: s.title ?? "YouTube の動画",
          channel: s.channel,
          by: nameOf(s.started_by),
        }
      : null,
    playing: !!s.video_id && s.playing,
    position: Number(s.position_s) || 0,
    updated_at: new Date(s.updated_at).getTime(),
    server_now: now,
    last: s.last_action
      ? { by: nameOf(s.last_actor), action: s.last_action }
      : null,
    queue: q.map((x) => ({
      id: x.id,
      video_id: x.video_id,
      title: x.title,
      channel: x.channel,
      by: nameOf(x.added_by),
    })),
    youtube_host: watchYoutubeHost(),
  };
}

/** 今の状態（6 時間触られていなければ片付けてから）。 */
export async function getState(now = Date.now()): Promise<WatchStateDto> {
  const { s, q } = await readRows(pool);
  if (s.video_id && now - new Date(s.updated_at).getTime() > IDLE_MS) {
    return (
      (await act(
        { email: "", userId: "" },
        { action: "idle_reset" },
        now,
        true,
      )) ?? toDto(s, q, now)
    );
  }
  return toDto(s, q, now);
}

/** 今の位置（秒）。 */
export function currentPosition(
  s: { playing: boolean; position_s: number; updated_at: Date },
  now: number,
): number {
  const base = Number(s.position_s) || 0;
  return s.playing
    ? base + Math.max(0, now - new Date(s.updated_at).getTime()) / 1000
    : base;
}

// ───────────────────────────────── 操作

const ACTIONS = new Set([
  "load",
  "play",
  "pause",
  "seek",
  "queue_add",
  "queue_remove",
  "queue_play",
  "next",
  "ended",
  "error",
  "stop",
]);

/** Web の連打よけ（アプリは withAgent の枠）。1 人 1 分 60 回。 */
const webHits = new Map<string, number[]>();
export function webRateOk(userId: string, now = Date.now()): boolean {
  const xs = (webHits.get(userId) ?? []).filter((t) => now - t < 60_000);
  if (xs.length >= 60) {
    webHits.set(userId, xs);
    return false;
  }
  xs.push(now);
  webHits.set(userId, xs);
  return true;
}

/**
 * 1 つの操作。結果の状態を返して全員に知らせる。変わらなかった（古い ended など）ときは今の状態を返す。
 * `system` は 6 時間の片付け（だれの操作でもない）。
 */
export async function act(
  actor: Actor,
  body: Record<string, unknown>,
  now = Date.now(),
  system = false,
): Promise<WatchStateDto> {
  const action = String(body.action ?? "");
  if (!system && !ACTIONS.has(action))
    throw new WatchError(400, "bad_action", "知らない操作です");

  // 動画の確かめは外（YouTube）に聞くので、ロックの前に済ませる。
  let incoming: { id: string; info: VideoInfo } | null = null;
  if (action === "load" || action === "queue_add") {
    const id = parseVideoId(body.video_id ?? body.url);
    if (!id)
      throw new WatchError(
        400,
        "bad_video",
        "YouTube の動画の URL を入れてください",
      );
    incoming = { id, info: await videoInfo(id) };
  }

  const c = await pool.connect();
  let notice: { text: string; merge: number | null } | null = null;
  let out: WatchStateDto;
  try {
    await c.query("BEGIN");
    await c.query(`SELECT pg_advisory_xact_lock(${LOCK_KEY})`);
    const { s, q } = await readRows(c);
    const pos = currentPosition(s, now);
    const by = system ? null : actor.userId;
    let changed = true;

    const setVideo = async (
      v: { id: string; title: string; channel: string | null } | null,
      start = 0,
    ) => {
      await c.query(
        `UPDATE watch_state SET video_id = $1, title = $2, channel = $3, started_by = $4, playing = $5, position_s = $6,
                updated_at = $7, version = version + 1, last_actor = $8, last_action = $9 WHERE id = 1`,
        [
          v?.id ?? null,
          v?.title ?? null,
          v?.channel ?? null,
          v ? by : null,
          !!v,
          start,
          new Date(now),
          by,
          action,
        ],
      );
    };
    const setPlayback = async (playing: boolean, position: number) => {
      await c.query(
        `UPDATE watch_state SET playing = $1, position_s = $2, updated_at = $3, version = version + 1, last_actor = $4, last_action = $5 WHERE id = 1`,
        [playing, position, new Date(now), by, action],
      );
    };
    const popNext = async (): Promise<boolean> => {
      const first = q[0];
      if (!first) return false;
      await c.query(`DELETE FROM watch_queue WHERE id = $1`, [first.id]);
      await setVideo({
        id: first.video_id,
        title: first.title,
        channel: first.channel,
      });
      return true;
    };
    const sameVideo = () => {
      const vid = parseVideoId(body.video_id);
      const ver = Number(body.version);
      return (
        !!s.video_id &&
        vid === s.video_id &&
        Number.isInteger(ver) &&
        ver === s.version
      );
    };

    switch (action) {
      case "load": {
        await setVideo(
          {
            id: incoming!.id,
            title: incoming!.info.title,
            channel: incoming!.info.channel,
          },
          clampPosition(body.position),
        );
        notice = { text: "", merge: null };
        break;
      }
      case "play":
      case "pause":
      case "seek": {
        if (!s.video_id)
          throw new WatchError(
            409,
            "no_video",
            "いま流している動画がありません",
          );
        const p =
          body.position === undefined ? pos : clampPosition(body.position);
        await setPlayback(
          action === "play" ? true : action === "pause" ? false : s.playing,
          p,
        );
        break;
      }
      case "queue_add": {
        if (q.length >= QUEUE_MAX)
          throw new WatchError(
            409,
            "queue_full",
            `見たいものリストは ${QUEUE_MAX} 本までです`,
          );
        if (q.some((x) => x.video_id === incoming!.id))
          throw new WatchError(
            409,
            "already_queued",
            "もうリストに入っています",
          );
        await c.query(
          `INSERT INTO watch_queue (video_id, title, channel, added_by) VALUES ($1, $2, $3, $4)`,
          [
            incoming!.id,
            incoming!.info.title,
            incoming!.info.channel,
            actor.userId,
          ],
        );
        // 何も流れていなければ、そのまま流す。
        if (!s.video_id) {
          const { q: q2 } = await readRows(c);
          const first = q2[0];
          await c.query(`DELETE FROM watch_queue WHERE id = $1`, [first.id]);
          await setVideo({
            id: first.video_id,
            title: first.title,
            channel: first.channel,
          });
          notice = { text: "", merge: null };
        } else {
          await c.query(
            `UPDATE watch_state SET version = version + 1, last_actor = $1, last_action = $2 WHERE id = 1`,
            [by, action],
          );
        }
        break;
      }
      case "queue_remove": {
        const id = Number(body.id);
        const r = await c.query(`DELETE FROM watch_queue WHERE id = $1`, [
          Number.isInteger(id) ? id : -1,
        ]);
        if (!r.rowCount) changed = false;
        else
          await c.query(
            `UPDATE watch_state SET version = version + 1, last_actor = $1, last_action = $2 WHERE id = 1`,
            [by, action],
          );
        break;
      }
      case "queue_play": {
        const id = Number(body.id);
        const item = q.find((x) => x.id === id);
        if (!item)
          throw new WatchError(404, "not_in_queue", "リストにありません");
        await c.query(`DELETE FROM watch_queue WHERE id = $1`, [item.id]);
        await setVideo({
          id: item.video_id,
          title: item.title,
          channel: item.channel,
        });
        notice = { text: "", merge: null };
        break;
      }
      case "next": {
        if (await popNext()) notice = { text: "", merge: null };
        else if (s.video_id) await setVideo(null);
        else changed = false;
        break;
      }
      case "ended":
      case "error": {
        // 何台から届いても、今の動画・今の版のときだけ 1 回進む。
        if (!sameVideo()) {
          changed = false;
          break;
        }
        if (await popNext()) notice = { text: "", merge: null };
        else await setVideo(null);
        break;
      }
      case "stop": {
        if (!s.video_id) changed = false;
        else await setVideo(null);
        break;
      }
      case "idle_reset": {
        if (!s.video_id || now - new Date(s.updated_at).getTime() <= IDLE_MS)
          changed = false;
        else await setVideo(null);
        break;
      }
    }

    const after = await readRows(c);
    if (notice && after.s.video_id) {
      const name =
        (await playersOf([after.s.started_by])).get(after.s.started_by ?? "")
          ?.name ?? "だれか";
      const skipped =
        action === "error"
          ? "（前の動画は再生できなかったので飛ばしたわん）"
          : "";
      notice.text = `📺 ${name}さんが「${after.s.title}」をみんなで見始めたわん${skipped}`;
      const recent =
        after.s.notice_msg_id &&
        after.s.notice_at &&
        now - new Date(after.s.notice_at).getTime() < NOTICE_MERGE_MS;
      notice.merge = recent ? after.s.notice_msg_id : null;
      if (recent && after.s.notice_text === notice.text) notice = null; // 同じ文なら書き換えない（知らせ直さない）
    }
    await c.query("COMMIT");
    out = await toDto(after.s, after.q, now);
    if (changed) emitLive({ type: "watch", state: out });
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }

  if (notice) {
    // チャットの 1 行（失敗しても見る方は止めない）。
    try {
      // 2 分以内の前の行は書き換える（消えていれば新しく 1 行）。
      const msg =
        (await postChatNotice(notice.text, notice.merge)) ??
        (notice.merge ? await postChatNotice(notice.text) : null);
      if (msg)
        await pool.query(
          `UPDATE watch_state SET notice_msg_id = $1, notice_at = $2, notice_text = $3 WHERE id = 1`,
          [msg.id, new Date(now), notice.text],
        );
    } catch (e) {
      console.error("watch notice:", (e as Error)?.message);
    }
  }
  return out;
}

/** テスト用: 全部消す。 */
export async function _resetWatchForTest(): Promise<void> {
  await pool.query(`DELETE FROM watch_queue`);
  await pool.query(`DELETE FROM watch_state`);
  webHits.clear();
  infoCache.clear();
}
