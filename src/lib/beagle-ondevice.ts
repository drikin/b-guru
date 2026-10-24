/* 🐶 端末内 AI のビーグル（ドリキン 2026-10-24）: チャットで「@ビーグル …」と書いた会員の iPhone / Mac
 * （Apple の端末内 AI、Foundation Models）がビーグルの答えを作り、ここからチャットに全員向けに出す。
 *
 * サーバは答えの中身が本当に AI の出力かを確かめられない。だから「ビーグルの発言」は、質問した会員の
 * 端末が出した、その会員の責任の発言として扱う（security-reviewer 2026-10-24）:
 *   - 発言者名を「ビーグル（〇〇さんの端末）」にする（古いアプリ・Android・Web でもそのまま見える）
 *   - アプリのログインで発行した鍵だけ（外部エージェントの鍵は不可）、本人が 10 分以内に書いた
 *     @ビーグル の質問 1 件に 1 回だけ
 *   - 1 人 24 時間 30 回・全体 300 回、本文 500 字、URL・@ は除く、push・メンション・未読なし
 *   - 誰が何を出したかを 30 日残す（beagle_ai_log。チャットは 24 時間で消える）
 *   - 答えがついた質問は編集できない、出した本人（と管理者）が消せる
 *   - BEAGLE_ONDEVICE_ENABLED で止められる（未設定＝誰にも出さない、メールのカンマ区切り、"1"＝全員）
 */
import { pool } from "./db";
import { SYSTEM_EMAIL } from "./posts";
import { resolveDisplayNames } from "./display-name";
import { emailToUserId } from "./user";
import { emitLive } from "./live";
import { featureEnabledFor } from "./feature-flag";
import { mapChatRow, type ChatMessage } from "./chat";

export const BEAGLE_ONDEVICE_FLAG = "BEAGLE_ONDEVICE_ENABLED";
export const BEAGLE_NAME = "ビーグル";
export const BEAGLE_AI_MAX_CHARS = 500;
export const BEAGLE_AI_PER_MEMBER_DAY = 30;
export const BEAGLE_AI_GLOBAL_DAY = 300;
/** 質問から答えまでの猶予。記録（beagle_ai_log）は 30 日で消える（lib/chat.ts の purgeExpiredChat）。 */
export const BEAGLE_AI_QUESTION_WINDOW = "10 minutes";

export function beagleOnDeviceEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor(BEAGLE_ONDEVICE_FLAG, email);
}

/** 本文が @ビーグル を呼んでいるか（「@ビーグルズ」のように名前の一部なら呼んでいない）。 */
export function asksBeagle(body: string): boolean {
  return /@ビーグル(?![\p{L}\p{N}])/u.test(body);
}

/** 出す本文: URL を取り、@ を全角にして呼び出しにしない、空白を整え、500 字まで。空なら null。 */
export function sanitizeBeagleAnswer(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/@/g, "＠")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!t) return null;
  if ([...t].length > BEAGLE_AI_MAX_CHARS) t = [...t].slice(0, BEAGLE_AI_MAX_CHARS - 1).join("") + "…";
  return t;
}

/** 発言者名: 誰の端末が出したかを、どの画面でも見えるように名前に入れる。 */
export function beagleAiAuthorName(memberName: string | null): string {
  const n = (memberName ?? "").trim() || "会員";
  return `${BEAGLE_NAME}（${n}さんの端末）`;
}

export type BeagleAiResult =
  | { ok: true; message: ChatMessage }
  | { ok: false; status: number; code: string; error: string };

/** 質問 `questionId` への、`email` の端末が作った答えを出す。 */
export async function postBeagleAiReply(input: {
  email: string;
  questionId: number;
  body: unknown;
  /** アプリと端末の版（記録用、64 字まで）。 */
  app?: unknown;
}): Promise<BeagleAiResult> {
  const fail = (status: number, code: string, error: string): BeagleAiResult => ({ ok: false, status, code, error });
  if (!beagleOnDeviceEnabledFor(input.email)) return fail(404, "not_enabled", "この機能は使えません");
  const body = sanitizeBeagleAnswer(input.body);
  if (!body) return fail(400, "invalid_request", "本文が空です");
  const app = typeof input.app === "string" ? input.app.slice(0, 64) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 全体の上限を数えるあいだ、同時の書き込みを 1 本にする。
    await client.query("SELECT pg_advisory_xact_lock(hashtext('beagle_ai_post'))");
    const q = await client.query(
      `SELECT id, author_email, body, kind FROM chat_messages
       WHERE id = $1 AND created_at >= now() - ($2::text)::interval`,
      [input.questionId, BEAGLE_AI_QUESTION_WINDOW]
    );
    const question = q.rows[0];
    if (!question || question.kind != null) {
      await client.query("ROLLBACK");
      return fail(404, "question_not_found", "答える質問が見つかりません（10 分以内の質問だけ）");
    }
    if (String(question.author_email).toLowerCase() !== input.email.toLowerCase()) {
      await client.query("ROLLBACK");
      return fail(403, "not_your_question", "自分の質問にだけ答えられます");
    }
    if (!asksBeagle(String(question.body))) {
      await client.query("ROLLBACK");
      return fail(400, "not_asking_beagle", "@ビーグル への質問ではありません");
    }
    const counts = await client.query(
      `SELECT count(*) FILTER (WHERE lower(ai_by_email) = lower($1))::int AS mine, count(*)::int AS total
       FROM beagle_ai_log WHERE created_at >= now() - interval '24 hours'`,
      [input.email]
    );
    if (counts.rows[0].mine >= BEAGLE_AI_PER_MEMBER_DAY) {
      await client.query("ROLLBACK");
      return fail(429, "rate_limited", "ビーグルへの質問は 24 時間で 30 回までです");
    }
    if (counts.rows[0].total >= BEAGLE_AI_GLOBAL_DAY) {
      await client.query("ROLLBACK");
      return fail(429, "rate_limited", "今日はビーグルが疲れちゃったわん。また明日");
    }
    const names = await resolveDisplayNames([input.email]);
    const ins = await client.query(
      `INSERT INTO chat_messages (author_email, author_name, body, kind, reply_to_id, ai_by_email)
       VALUES ($1, $2, $3, 'beagle_ai', $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id, author_email, author_name, body, edited, edited_at, created_at, images, kind, reply_to_id`,
      [SYSTEM_EMAIL, beagleAiAuthorName(names.get(input.email) ?? null), body, input.questionId, input.email]
    );
    const row = ins.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return fail(409, "already_answered", "この質問にはもう答えています");
    }
    await client.query(
      `INSERT INTO beagle_ai_log (chat_message_id, question_id, question_body, answer, ai_by_email, app)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [row.id, input.questionId, question.body, body, input.email, app]
    );
    await client.query("COMMIT");
    const message = await mapChatRow(row, null, await emailToUserId(SYSTEM_EMAIL));
    const { isAuthor: _perReceiver, ...broadcast } = message;
    // push・メンション・未読なし（sendChatMessage を通さない。未読は getUnreadCount が kind で除く）。
    emitLive({ type: "chat", message: broadcast, action: "create" });
    return { ok: true, message };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** 出した本人が自分の端末の答えを消す（管理者はいつもの削除で消せる）。 */
export async function deleteBeagleAiReply(email: string, id: number): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM chat_messages WHERE id = $1 AND kind = 'beagle_ai' AND lower(ai_by_email) = lower($2) RETURNING id`,
    [id, email]
  );
  if (!r.rowCount) return false;
  emitLive({ type: "chat", action: "delete", message: { id } });
  return true;
}
