/* 音声をスマホで続ける（docs/device-sync-spec.md §2）。Mac・Web の「スマホで続ける」から、
 * 本人の notify_sync 端末へ知らせを 1 件送る。音声の引き継ぎそのものは、スマホが同じ identity
 * （userId）で入ると LiveKit が前の端末を切ることで起きる（話す役はサーバにあるのでそのまま）。 */
import { pool } from "./db";
import { offkaiEnabledFor } from "./offkai";
import { pushVoiceHandoff, type HandoffTarget } from "./push-notify";
import { roomEnabledFor } from "./room";
import { voiceEnabledFor } from "./voice";

type Result = { status: number; body: Record<string, unknown> };

export function parseHandoffTarget(v: unknown): HandoffTarget | null {
  return v === "offkai" || v === "voice" || v === "room" ? v : null;
}

export async function requestVoiceHandoff(email: string, input: Record<string, unknown> | null): Promise<Result> {
  const target = parseHandoffTarget(input?.target);
  if (!target) return { status: 400, body: { error: "target が不正です", code: "invalid_request" } };
  const mic = input?.mic === true;
  const enabled = target === "offkai" ? offkaiEnabledFor(email) : target === "room" ? roomEnabledFor(email) : voiceEnabledFor(email);
  if (!enabled) return { status: 404, body: { error: "使えない機能です", code: "not_found" } };
  let eventId: number | null = null;
  if (target === "offkai") {
    const r = await pool.query(`SELECT id FROM offkai_events WHERE ended_at IS NULL AND ends_at > now() ORDER BY id DESC LIMIT 1`);
    eventId = (r.rows[0]?.id as number | undefined) ?? null;
    if (eventId == null) return { status: 409, body: { error: "オフ会は開いていません", code: "not_open" } };
  }
  const sent = await pushVoiceHandoff(email, target, mic, eventId);
  return { status: 200, body: { ok: true, sent } };
}
