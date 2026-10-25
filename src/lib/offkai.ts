/* 🍻 オフ会（docs/offkai-spec.md）。突発オフ会に来られない人が、オンラインから参加している気分になれるようにする。
 *
 *   - 開催中は 1 つだけ（offkai_events の部分 unique index）。誰でも始められる。開始から 6 時間で自動で終わる。
 *   - 声: 現地の 1 台が流し、ほかは聞く。話せるのは常に 1 人で、後から「話す」を押した人に切り替わる（後勝ち）。
 *     DB の speaker を正とし、LiveKit の権限は reconcileSpeaker 1 本で合わせる（交代が速くても順番が狂わない）。
 *   - 写真: offkai-… として保存（チャットの写真と違い掃除されない）、chat-… の複製をチャットにも流す。
 *   - 知らせ: 始まったときに 1 回だけ全員へ push。チャットの小さな行・終了時のタイムライン投稿は公開後だけ。
 * メールは外へ出さない（人は user_id・表示名・アバター）。 */
import { copyFile, readdir, rm } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { pool } from "./db";
import { emitLive } from "./live";
import { createPost, gravatarUrl, SYSTEM_EMAIL } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emailToUserIds } from "./user";
import { isAdmin } from "./admin";
import { featureEnabledFor, featurePublic } from "./feature-flag";
import { postChatNotice, sendChatMessage } from "./chat";
import { livekitConfig, roomService, signAccessToken } from "./livekit";
import { mediaCacheDir } from "./media-variants";
import { pushOffkaiStart } from "./push-notify";
import { CHAT_UPLOAD, OFFKAI_UPLOAD_PREFIX } from "./upload";

export const OFFKAI_FLAG = "OFFKAI_ENABLED";
export const OFFKAI_DURATION_MS = 6 * 60 * 60 * 1000;
/** 話す人が部屋を出てからこれだけ戻らなければ、話す人を空にする。 */
export const SPEAKER_GRACE_MS = 60_000;
export const TITLE_MAX = 40;
export const CAPTION_MAX = 200;
export const ROOM_PREFIX = "bguru-offkai-";
export const ARCHIVE_PAGE = 20;
export const PHOTOS_PAGE = 100;
export const PHOTOS_PAGE_MAX = 200;
/** 1 人が 1 つのオフ会に上げられる写真（ずっと残るのでディスクを守る）。 */
export const PHOTOS_PER_PERSON = 200;
const TOKEN_TTL_SEC = 2 * 60;
const MAX_PARTICIPANTS = 100;
const BEAGLE_NAME = "ビーグル";

export function offkaiEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor(OFFKAI_FLAG, email);
}

/** チャットの行・push・タイムライン投稿は、全員に公開してからだけ（試しの間は外に出さない）。 */
function announce(): boolean {
  return featurePublic(OFFKAI_FLAG);
}

export class OffkaiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export type Actor = { email: string; userId: string };
export type PersonDto = { user_id: string; name: string | null; avatar: string };
export type EventDto = {
  id: number;
  version: number;
  title: string;
  started_by: PersonDto;
  started_at: string;
  ends_at: string;
  ended_at: string | null;
  speaker: (PersonDto & { connected: boolean }) | null;
  photo_count: number;
  cover: string | null;
  /** 見ている人が「終了」を押せるか（始めた人・管理者。話す人は後勝ちで誰でもなれるので含めない）。 */
  can_end: boolean;
};
export type PhotoDto = { id: number; url: string; uploader: PersonDto; caption: string; created_at: string; mine: boolean };

type Row = {
  id: number;
  title: string;
  started_by_email: string;
  started_at: Date;
  ends_at: Date;
  ended_at: Date | null;
  ended_by_email: string | null;
  speaker_email: string | null;
  speaker_since: Date | null;
  speaker_left_at: Date | null;
  version: number;
  finalized_at: Date | null;
  summary_post_id: number | null;
  notice_msg_id: number | null;
  photo_count?: number | string;
  cover?: string | null;
};

const norm = (e: string) => e.trim().toLowerCase();
export const roomName = (id: number) => `${ROOM_PREFIX}${id}`;

// ---- 人 ----

async function persons(emails: string[]): Promise<Map<string, PersonDto>> {
  const uniq = [...new Set(emails.filter(Boolean))];
  const [ids, names] = await Promise.all([emailToUserIds(uniq), resolveDisplayNames(uniq)]);
  const out = new Map<string, PersonDto>();
  for (const e of uniq) {
    out.set(e, {
      user_id: ids.get(norm(e)) ?? "",
      name: e === SYSTEM_EMAIL ? BEAGLE_NAME : names.get(e) ?? null,
      avatar: gravatarUrl(e),
    });
  }
  return out;
}

// ---- LiveKit の部屋（いる人のキャッシュ） ----

type LkPerm = { canPublish?: boolean; can_publish?: boolean };
type LkParticipant = { identity?: string; state?: string | number; permission?: LkPerm; tracks?: { sid?: string; type?: string | number; muted?: boolean }[] };

const g = globalThis as unknown as {
  __offkaiRoom?: { eventId: number; identities: Set<string>; at: number };
  __offkaiReconcile?: Promise<void> | null;
  __offkaiReconcileAgain?: boolean;
  __offkaiSweeper?: ReturnType<typeof setInterval>;
  __offkaiRate?: Map<string, number[]>;
};

function roomIdentities(eventId: number): Set<string> {
  const r = g.__offkaiRoom;
  return r && r.eventId === eventId ? r.identities : new Set();
}

async function listRoom(eventId: number): Promise<LkParticipant[]> {
  const cfg = livekitConfig();
  if (!cfg) return [];
  const room = roomName(eventId);
  const res = await roomService<{ participants?: LkParticipant[] }>(cfg, "ListParticipants", { room }, room);
  const live = (res?.participants ?? []).filter((p) => p.state !== "DISCONNECTED" && p.state !== 3);
  const ids = new Set(live.map((p) => p.identity ?? "").filter(Boolean));
  const prev = g.__offkaiRoom;
  g.__offkaiRoom = { eventId, identities: ids, at: Date.now() };
  if (!prev || prev.eventId !== eventId || prev.identities.size !== ids.size) {
    emitLive({ type: "offkai", action: "listeners", listeners: ids.size });
  }
  return live;
}

export function listenerCount(eventId: number): number {
  return roomIdentities(eventId).size;
}

/** 権限は全体の置き換え（UpdateParticipant の permission）なので、毎回すべて送る。 */
function permission(canPublish: boolean) {
  return {
    can_subscribe: true,
    can_publish: canPublish,
    can_publish_data: false,
    can_publish_sources: canPublish ? ["MICROPHONE"] : [],
    can_update_metadata: false,
  };
}

/** DB の speaker に LiveKit を合わせる（speaker 以外のマイクを取り上げ、speaker に与える）。同時に 1 本だけ。
 *  走っている間に呼ばれたら、終わったあともう 1 回だけ走る（その間の DB の変化を拾う）。 */
export async function reconcileSpeaker(): Promise<void> {
  if (g.__offkaiReconcile) {
    g.__offkaiReconcileAgain = true;
    return g.__offkaiReconcile;
  }
  g.__offkaiReconcile = (async () => {
    try {
      do {
        g.__offkaiReconcileAgain = false;
        await reconcileOnce();
      } while (g.__offkaiReconcileAgain);
    } finally {
      g.__offkaiReconcile = null;
    }
  })();
  return g.__offkaiReconcile;
}

async function reconcileOnce(): Promise<void> {
  const cfg = livekitConfig();
  if (!cfg) return;
  const ev = await currentRow();
  if (!ev) return;
  const room = roomName(ev.id);
  const speakerId = ev.speaker_email ? (await emailToUserIds([ev.speaker_email])).get(norm(ev.speaker_email)) ?? null : null;
  const people = await listRoom(ev.id);
  for (const p of people) {
    if (!p.identity) continue;
    const should = p.identity === speakerId;
    const has = !!(p.permission?.canPublish ?? p.permission?.can_publish);
    if (should === has) continue;
    await roomService(cfg, "UpdateParticipant", { room, identity: p.identity, permission: permission(should) }, room).catch((e) =>
      console.error("[offkai] permission:", (e as Error)?.message),
    );
    if (!should) {
      // 権限を外せば LiveKit が止めるはずだが、念のためマイクも黙らせる。
      for (const t of (p.tracks ?? []).filter((t) => t.sid && !t.muted && (t.type === "AUDIO" || t.type === 0))) {
        await roomService(cfg, "MutePublishedTrack", { room, identity: p.identity, track_sid: t.sid, muted: true }, room).catch(() => {});
      }
    }
  }
  // 話す人が部屋にいるかどうかが変わったら知らせる（「◯◯が話しています」は部屋にいるときだけ）。
  const connected = !!speakerId && people.some((p) => p.identity === speakerId);
  if (ev.speaker_email) {
    if (!connected && !ev.speaker_left_at) {
      await touch(ev.id, `speaker_left_at = now()`);
    } else if (connected && ev.speaker_left_at) {
      await touch(ev.id, `speaker_left_at = NULL`);
    } else if (!connected && ev.speaker_left_at && Date.now() - new Date(ev.speaker_left_at).getTime() > SPEAKER_GRACE_MS) {
      await touch(ev.id, `speaker_email = NULL, speaker_since = NULL, speaker_left_at = NULL`);
    }
  }
}

/** 1 列だけ書き換えて版を上げ、全員に知らせる。 */
async function touch(id: number, set: string): Promise<void> {
  const r = await pool.query(`UPDATE offkai_events SET ${set}, version = version + 1 WHERE id = $1 AND ended_at IS NULL RETURNING id`, [id]);
  if (r.rowCount) await broadcast("update", id);
}

// ---- 読む ----

const SELECT = `SELECT e.*, (SELECT count(*) FROM offkai_photos p WHERE p.event_id = e.id) AS photo_count,
  (SELECT p.path FROM offkai_photos p WHERE p.event_id = e.id ORDER BY p.id LIMIT 1) AS cover
  FROM offkai_events e`;

async function currentRow(): Promise<Row | null> {
  await expireDue();
  const r = await pool.query(`${SELECT} WHERE e.ended_at IS NULL ORDER BY e.id DESC LIMIT 1`);
  return (r.rows[0] as Row) ?? null;
}

async function toDtos(rows: Row[], viewerEmail: string | null): Promise<EventDto[]> {
  const people = await persons(rows.flatMap((r) => [r.started_by_email, r.speaker_email ?? ""]));
  const viewer = viewerEmail ? norm(viewerEmail) : null;
  return rows.map((r) => {
    const sp = r.speaker_email ? people.get(r.speaker_email)! : null;
    const open = !r.ended_at;
    return {
      id: r.id,
      version: r.version,
      title: r.title,
      started_by: people.get(r.started_by_email)!,
      started_at: new Date(r.started_at).toISOString(),
      ends_at: new Date(r.ends_at).toISOString(),
      ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      speaker: sp ? { ...sp, connected: !!sp.user_id && roomIdentities(r.id).has(sp.user_id) } : null,
      photo_count: Number(r.photo_count ?? 0),
      cover: r.cover ?? null,
      can_end: open && !!viewer && (norm(r.started_by_email) === viewer || isAdmin(viewer)),
    };
  });
}

/** 知らせの event は見る人を問わない形（can_end は各端末が自分で決める材料がないので false）。 */
async function broadcast(action: "start" | "update" | "end", id: number): Promise<void> {
  const r = await pool.query(`${SELECT} WHERE e.id = $1`, [id]);
  if (!r.rows[0]) return;
  const [event] = await toDtos([r.rows[0] as Row], null);
  emitLive({ type: "offkai", action, event });
}

export async function getState(actor: Actor, before?: number | null) {
  const cur = await currentRow();
  const arch = await pool.query(
    `${SELECT} WHERE e.ended_at IS NOT NULL AND ($1::int IS NULL OR e.id < $1) ORDER BY e.id DESC LIMIT $2`,
    [before ?? null, ARCHIVE_PAGE],
  );
  if (cur && !g.__offkaiRoom) await listRoom(cur.id).catch(() => []);
  const [current] = cur ? await toDtos([cur], actor.email) : [null];
  return {
    enabled: true,
    can: { start: !cur, speak: !!cur, upload: !!cur },
    /** 管理者はどの会も終了できる（知らせの event の can_end は常に false なので、端末はこれと始めた人で決める）。 */
    is_admin: isAdmin(actor.email),
    current: current ?? null,
    listeners: cur ? listenerCount(cur.id) : 0,
    archive: await toDtos(arch.rows as Row[], actor.email),
  };
}

export async function getEvent(actor: Actor, id: number): Promise<EventDto> {
  await expireDue();
  const r = await pool.query(`${SELECT} WHERE e.id = $1`, [id]);
  if (!r.rows[0]) throw new OffkaiError(404, "not_found", "オフ会が見つかりません");
  return (await toDtos([r.rows[0] as Row], actor.email))[0];
}

export async function listPhotos(actor: Actor, eventId: number, after: number | null, limitRaw: unknown) {
  const ev = await pool.query(`SELECT id FROM offkai_events WHERE id = $1`, [eventId]);
  if (!ev.rows[0]) throw new OffkaiError(404, "not_found", "オフ会が見つかりません");
  const n = Number(limitRaw);
  const limit = Number.isInteger(n) && n > 0 ? Math.min(n, PHOTOS_PAGE_MAX) : PHOTOS_PAGE;
  const r = await pool.query(
    `SELECT id, path, uploader_email, caption, created_at FROM offkai_photos
     WHERE event_id = $1 AND ($2::int IS NULL OR id > $2) ORDER BY id LIMIT $3`,
    [eventId, after, limit + 1],
  );
  const rows = r.rows.slice(0, limit) as { id: number; path: string; uploader_email: string; caption: string; created_at: Date }[];
  const people = await persons(rows.map((x) => x.uploader_email));
  return {
    photos: rows.map((x) => photoDto(x, people, actor.email)),
    next_after: r.rows.length > limit ? rows[rows.length - 1].id : null,
  };
}

function photoDto(
  x: { id: number; path: string; uploader_email: string; caption: string; created_at: Date },
  people: Map<string, PersonDto>,
  viewerEmail: string | null,
): PhotoDto {
  return {
    id: x.id,
    url: x.path,
    uploader: people.get(x.uploader_email)!,
    caption: x.caption,
    created_at: new Date(x.created_at).toISOString(),
    mine: !!viewerEmail && norm(x.uploader_email) === norm(viewerEmail),
  };
}

// ---- 回数の枠（Web もアプリも、1 人ごと） ----

const RATE: Record<string, { limit: number; windowMs: number }> = {
  start: { limit: 5, windowMs: 60 * 60_000 },
  photo: { limit: 60, windowMs: 60 * 60_000 },
  speak: { limit: 60, windowMs: 60 * 60_000 },
  token: { limit: 120, windowMs: 60 * 60_000 },
};

export function rateOk(kind: keyof typeof RATE, userId: string, now = Date.now()): boolean {
  const rule = RATE[kind];
  const m = (g.__offkaiRate ??= new Map<string, number[]>());
  const key = `${kind}:${userId}`;
  const hits = (m.get(key) ?? []).filter((t: number) => now - t < rule.windowMs);
  if (hits.length >= rule.limit) {
    m.set(key, hits);
    return false;
  }
  hits.push(now);
  m.set(key, hits);
  return true;
}

function limited(kind: keyof typeof RATE, actor: Actor) {
  if (!rateOk(kind, actor.userId)) throw new OffkaiError(429, "rate_limited", "操作が多すぎます。少し待ってください");
}

// ---- 操作 ----

export function cleanTitle(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, TITLE_MAX) : "";
}

export async function start(actor: Actor, input: { title?: unknown }): Promise<EventDto> {
  limited("start", actor);
  const title = cleanTitle(input.title);
  await expireDue();
  let id: number;
  try {
    const r = await pool.query(
      `INSERT INTO offkai_events (title, started_by_email, ends_at) VALUES ($1, $2, now() + ($3::text || ' milliseconds')::interval) RETURNING id`,
      [title, actor.email, String(OFFKAI_DURATION_MS)],
    );
    id = r.rows[0].id;
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      const cur = await currentRow();
      const [event] = cur ? await toDtos([cur], actor.email) : [null];
      throw new OffkaiError(409, "busy", "ほかのオフ会が開催中です", { current: event });
    }
    throw e;
  }
  await broadcast("start", id);
  if (announce()) {
    const who = (await persons([actor.email])).get(actor.email)?.name ?? "だれか";
    const notice = await postChatNotice(`🍻 ${who}さんがオフ会を始めました${title ? `（${title}）` : ""}。🍻 から聞けます`).catch(() => null);
    if (notice) await pool.query(`UPDATE offkai_events SET notice_msg_id = $1 WHERE id = $2`, [notice.id, id]);
    // 同じ人が終えて 1 時間以内に始め直したのは、やり直し（同じ集まり）なので知らせ直さない。
    const redo = await pool.query(
      `SELECT 1 FROM offkai_events WHERE id <> $1 AND lower(started_by_email) = lower($2) AND ended_at > now() - interval '1 hour' LIMIT 1`,
      [id, actor.email],
    );
    if (!redo.rowCount) void pushOffkaiStart(id, actor.email).catch((e) => console.error("[offkai] push:", (e as Error)?.message));
  }
  ensureOffkaiSweeper();
  return getEvent(actor, id);
}

/** 話す（後勝ち）・やめる。話す人には話せる鍵も返す。 */
export async function speak(actor: Actor, on: boolean) {
  limited("speak", actor);
  const client = await pool.connect();
  let id: number;
  try {
    await client.query("BEGIN");
    const r = await client.query(`SELECT id, speaker_email FROM offkai_events WHERE ended_at IS NULL AND ends_at > now() FOR UPDATE`);
    if (!r.rows[0]) throw new OffkaiError(409, "not_open", "開催中のオフ会はありません");
    id = r.rows[0].id;
    const mine = r.rows[0].speaker_email && norm(r.rows[0].speaker_email) === norm(actor.email);
    if (on && !mine) {
      await client.query(
        `UPDATE offkai_events SET speaker_email = $2, speaker_since = now(), speaker_left_at = NULL, version = version + 1 WHERE id = $1`,
        [id, actor.email],
      );
    } else if (!on && mine) {
      await client.query(
        `UPDATE offkai_events SET speaker_email = NULL, speaker_since = NULL, speaker_left_at = NULL, version = version + 1 WHERE id = $1`,
        [id],
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await broadcast("update", id);
  void reconcileSpeaker().catch((e) => console.error("[offkai] reconcile:", (e as Error)?.message));
  // 音声が使えなくても（LiveKit の設定なし）話す人の切り替えは通す。鍵は付かない。
  const tok = await joinToken(actor, id).catch((e) => (e instanceof OffkaiError ? null : Promise.reject(e)));
  return { event: await getEvent(actor, id), ...(tok ?? {}) };
}

/** 部屋に入る鍵（2 分）。話す人なら話せる鍵。 */
export async function token(actor: Actor) {
  limited("token", actor);
  const cur = await currentRow();
  if (!cur) throw new OffkaiError(409, "not_open", "開催中のオフ会はありません");
  return joinToken(actor, cur.id);
}

async function joinToken(actor: Actor, id: number) {
  const cfg = livekitConfig();
  if (!cfg) throw new OffkaiError(503, "voice_unavailable", "音声は今使えません");
  const r = await pool.query(`SELECT speaker_email FROM offkai_events WHERE id = $1`, [id]);
  const canSpeak = !!r.rows[0]?.speaker_email && norm(r.rows[0].speaker_email) === norm(actor.email);
  const name = (await persons([actor.email])).get(actor.email)?.name ?? null;
  const room = roomName(id);
  const tok = signAccessToken(cfg, {
    identity: actor.userId,
    name: name ?? undefined,
    ttlSec: TOKEN_TTL_SEC,
    video: {
      room,
      roomJoin: true,
      canPublish: canSpeak,
      canSubscribe: true,
      canPublishData: false,
      canPublishSources: canSpeak ? ["microphone"] : [],
      canUpdateOwnMetadata: false,
    },
    roomConfig: { maxParticipants: MAX_PARTICIPANTS, emptyTimeout: 10 * 60, departureTimeout: 20 },
  });
  return { token: tok, url: cfg.url, room, can_speak: canSpeak };
}

export async function end(actor: Actor): Promise<EventDto> {
  const cur = await currentRow();
  if (!cur) throw new OffkaiError(409, "not_open", "開催中のオフ会はありません");
  const me = norm(actor.email);
  // 話す人は後勝ちで誰でもなれるので、終了は始めた人と管理者だけ（「話す」→「終了」で他人の会を終わらせない）。
  if (norm(cur.started_by_email) !== me && !isAdmin(me)) throw new OffkaiError(403, "forbidden", "終了できるのは始めた人だけです");
  await closeEvent(cur.id, actor.email, false);
  return getEvent(actor, cur.id);
}

/** 終わらせる（勝った 1 者だけが後処理）。auto = 期限で（ended_at は ends_at）。 */
async function closeEvent(id: number, byEmail: string | null, auto: boolean): Promise<boolean> {
  const r = await pool.query(
    `UPDATE offkai_events SET ended_at = ${auto ? "ends_at" : "now()"}, ended_by_email = $2,
       speaker_email = NULL, speaker_since = NULL, speaker_left_at = NULL, version = version + 1
     WHERE id = $1 AND ended_at IS NULL RETURNING id`,
    [id, byEmail],
  );
  if (!r.rowCount) return false;
  await broadcast("end", id);
  await finalize(id).catch((e) => console.error("[offkai] finalize:", (e as Error)?.message));
  return true;
}

/** 期限を過ぎた開催中を終わらせる（読むとき・始めるとき・見回り）。 */
export async function expireDue(): Promise<void> {
  const r = await pool.query(`SELECT id FROM offkai_events WHERE ended_at IS NULL AND ends_at <= now()`);
  for (const row of r.rows) await closeEvent(row.id, null, true);
}

/** 終了の後処理（冪等）: 部屋を消す・チャットの行・タイムライン投稿。途中で落ちても見回りがやり直す。 */
async function finalize(id: number): Promise<void> {
  // 権利を取った 1 者だけ（終了の直後と見回りが重なっても 2 回走らない）。2 分たっても済んでいなければ
  // 途中で落ちたものとみなして取り直せる。行と投稿は済んだ印（end_notice_msg_id・summary_post_id）を見て出し直さない。
  const claim = await pool.query(
    `UPDATE offkai_events SET finalizing_at = now()
     WHERE id = $1 AND ended_at IS NOT NULL AND finalized_at IS NULL
       AND (finalizing_at IS NULL OR finalizing_at < now() - interval '2 minutes')
     RETURNING id`,
    [id],
  );
  if (!claim.rowCount) return;
  const r = await pool.query(`${SELECT} WHERE e.id = $1`, [id]);
  const ev = r.rows[0] as (Row & { end_notice_msg_id?: number | null }) | undefined;
  if (!ev) return;
  const cfg = livekitConfig();
  if (cfg) await roomService(cfg, "DeleteRoom", { room: roomName(id) }, roomName(id)).catch(() => null);
  if (g.__offkaiRoom?.eventId === id) g.__offkaiRoom = undefined;
  const count = Number(ev.photo_count ?? 0);
  if (announce()) {
    // 題は「渋谷で飲んでます」のような文のこともあるので、括弧に入れる。
    const name = ev.title ? `オフ会（${ev.title}）` : "オフ会";
    if (!ev.end_notice_msg_id) {
      const notice = await postChatNotice(`🍻 ${name}が終わりました（写真 ${count} 枚）。🍻 のアーカイブから見返せます`).catch(() => null);
      if (notice) await pool.query(`UPDATE offkai_events SET end_notice_msg_id = $1 WHERE id = $2`, [notice.id, id]);
    }
    if (count > 0 && !ev.summary_post_id) {
      const covers = await pool.query(`SELECT path FROM offkai_photos WHERE event_id = $1 ORDER BY id LIMIT 4`, [id]);
      const post = await createPost({
        authorEmail: SYSTEM_EMAIL,
        authorName: BEAGLE_NAME,
        text: `🍻 ${name}のアルバム（写真 ${count} 枚）だわん。チャットの 🍻 のアーカイブから全部見られます`,
        images: covers.rows.map((x) => x.path as string),
        noPreview: true,
      });
      await pool.query(`UPDATE offkai_events SET summary_post_id = $1 WHERE id = $2`, [post.id, id]);
    }
  }
  await pool.query(`UPDATE offkai_events SET finalized_at = now() WHERE id = $1`, [id]);
}

// ---- 写真 ----

const OFFKAI_PATH_RE = /^\/api\/media\/offkai-[0-9]+-[0-9a-f]+\.(jpe?g|png|webp|gif)$/i;
const uploadsDir = () => path.join(process.cwd(), "public", "uploads");

/** 上げたばかりの offkai-… をアルバムに入れ、chat-… の複製をチャットにも流す。urls はこの要求で
 *  サーバが書いたものだけ（呼び出し側が handleUpload の結果を渡す）。 */
export async function addPhotos(actor: Actor, urls: string[], captionRaw: unknown): Promise<PhotoDto[]> {
  const files = urls.filter((u) => OFFKAI_PATH_RE.test(u)).slice(0, CHAT_UPLOAD.maxImages);
  if (files.length === 0) throw new OffkaiError(400, "invalid_request", "写真がありません");
  const cur = await currentRow();
  if (!cur) {
    await removeFiles(files);
    throw new OffkaiError(409, "not_open", "開催中のオフ会はありません");
  }
  const have = await pool.query(`SELECT count(*)::int AS n FROM offkai_photos WHERE event_id = $1 AND lower(uploader_email) = lower($2)`, [cur.id, actor.email]);
  if (have.rows[0].n + files.length > PHOTOS_PER_PERSON) {
    await removeFiles(files);
    throw new OffkaiError(409, "too_many", `写真は 1 人 ${PHOTOS_PER_PERSON} 枚までです`);
  }
  const caption = typeof captionRaw === "string" ? captionRaw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().slice(0, CAPTION_MAX) : "";
  const ins = await pool
    .query(
      `INSERT INTO offkai_photos (event_id, path, uploader_email, caption)
       SELECT $1, u, $2, $3 FROM unnest($4::text[]) WITH ORDINALITY AS t(u, n) ORDER BY n
       RETURNING id, path, uploader_email, caption, created_at`,
      [cur.id, actor.email, caption, files],
    )
    .catch(async (e) => {
      await removeFiles(files); // 入れられなかったファイルは残さない
      throw e;
    });
  const people = await persons([actor.email]);
  const photos = ins.rows.map((x) => photoDto(x, people, actor.email));
  for (const p of ins.rows.map((x) => photoDto(x, people, null))) emitLive({ type: "offkai", action: "photo", eventId: cur.id, photo: p });
  await touch(cur.id, `ended_at = ended_at`); // 枚数が変わった版を全員へ
  // チャットにも（24 時間で消えるいつもの写真として。アルバムの原本は消えない）。
  try {
    const chatUrls: string[] = [];
    for (const u of files) {
      const name = `${CHAT_UPLOAD.prefix}${Date.now()}-${crypto.randomBytes(6).toString("hex")}${path.extname(u)}`;
      await copyFile(path.join(uploadsDir(), path.basename(u)), path.join(uploadsDir(), name));
      chatUrls.push(`/api/media/${name}`);
    }
    await sendChatMessage(actor.email, caption ? `🍻 ${caption}` : "🍻", null, chatUrls);
  } catch (e) {
    console.error("[offkai] chat copy:", (e as Error)?.message);
  }
  return photos;
}

export async function deletePhoto(actor: Actor, photoId: number): Promise<void> {
  const r = await pool.query(`SELECT id, event_id, path, uploader_email FROM offkai_photos WHERE id = $1`, [photoId]);
  const row = r.rows[0];
  if (!row) throw new OffkaiError(404, "not_found", "写真が見つかりません");
  if (norm(row.uploader_email) !== norm(actor.email) && !isAdmin(actor.email)) {
    throw new OffkaiError(403, "forbidden", "消せるのは上げた本人だけです");
  }
  await pool.query(`DELETE FROM offkai_photos WHERE id = $1`, [photoId]);
  // 終了時のタイムライン投稿に載っていれば、そこからも外す。
  await pool.query(`DELETE FROM post_images WHERE url = $1`, [row.path]);
  await removeFiles([row.path]);
  emitLive({ type: "offkai", action: "photo_delete", eventId: row.event_id, photoId });
  const open = await pool.query(`SELECT 1 FROM offkai_events WHERE id = $1 AND ended_at IS NULL`, [row.event_id]);
  if (open.rowCount) await pool.query(`UPDATE offkai_events SET version = version + 1 WHERE id = $1`, [row.event_id]);
  await broadcast("update", row.event_id);
}

/** 原本と縮小版（data/media-cache の <名前>__<幅>.<拡張子>）を消す。 */
async function removeFiles(urls: string[]): Promise<void> {
  const names = urls.map((u) => path.basename(u)).filter((n) => n.startsWith(OFFKAI_UPLOAD_PREFIX));
  await Promise.all(names.map((n) => rm(path.join(uploadsDir(), n), { force: true }).catch(() => {})));
  let cached: string[] = [];
  try {
    cached = await readdir(mediaCacheDir());
  } catch {
    return;
  }
  await Promise.all(
    cached
      .filter((c) => names.some((n) => c.startsWith(`${n}__`)))
      .map((c) => rm(path.join(mediaCacheDir(), c), { force: true }).catch(() => {})),
  );
}

// ---- LiveKit の webhook（bguru-offkai-*） ----

export async function handleOffkaiWebhook(ev: { event?: string; room?: { name?: string } }): Promise<void> {
  const name = ev.room?.name ?? "";
  if (!name.startsWith(ROOM_PREFIX)) return;
  ensureOffkaiSweeper();
  if (ev.event === "participant_joined") {
    // 終わった会の部屋に（古い鍵・再接続で）入り直されたら、部屋ごと消す。
    const id = Number(name.slice(ROOM_PREFIX.length));
    const open = Number.isInteger(id) && id > 0 ? await pool.query(`SELECT 1 FROM offkai_events WHERE id = $1 AND ended_at IS NULL`, [id]) : null;
    if (!open?.rowCount) {
      const cfg = livekitConfig();
      if (cfg) await roomService(cfg, "DeleteRoom", { room: name }, name).catch(() => null);
      return;
    }
  }
  if (ev.event === "participant_joined" || ev.event === "participant_left" || ev.event === "room_finished") {
    await reconcileSpeaker();
  }
}

// ---- 見回り（期限・話す人の離席・後処理のやり直し） ----

export function ensureOffkaiSweeper(): void {
  if (g.__offkaiSweeper) return;
  const tick = async () => {
    try {
      await expireDue();
      const pending = await pool.query(`SELECT id FROM offkai_events WHERE ended_at IS NOT NULL AND finalized_at IS NULL`);
      for (const row of pending.rows) await finalize(row.id);
      const open = await pool.query(`SELECT 1 FROM offkai_events WHERE ended_at IS NULL`);
      if (open.rowCount) await reconcileSpeaker();
    } catch (e) {
      console.error("[offkai] sweep:", (e as Error)?.message);
    }
  };
  g.__offkaiSweeper = setInterval(tick, 10_000);
  g.__offkaiSweeper.unref?.();
  void tick();
}

/** テスト用。 */
export function _resetOffkaiForTest(): void {
  if (g.__offkaiSweeper) clearInterval(g.__offkaiSweeper);
  g.__offkaiSweeper = undefined;
  g.__offkaiRoom = undefined;
  g.__offkaiRate = undefined;
  g.__offkaiReconcile = null;
}
