/* ✉️ 簡易 DM の API の中身（Web の /api/dm/** とアプリの /api/agent/dm/** で共通）。
 * 認証（セッション / アプリの鍵）はルートが済ませ、ここには本人（DmActor）だけが来る。
 * DM_ENABLED の対象でない人には 404（機能が無いのと同じ）。応答はすべて { status, body }。 */
import {
  DmError,
  ensureDmSweeper,
  getDmMessage,
  listDmConversations,
  listDmMessages,
  markDmRead,
  sendDm,
  dmEnabledFor,
  type DmActor,
} from "./dm";

export const DM_API_VERSION = 1;

export type DmApiResult = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

const NOT_ENABLED: DmApiResult = { status: 404, body: { error: "DM はまだ使えません", code: "not_found" } };

async function run(actor: DmActor, fn: () => Promise<Record<string, unknown>>, okStatus = 200): Promise<DmApiResult> {
  if (!dmEnabledFor(actor.email)) return NOT_ENABLED;
  ensureDmSweeper();
  try {
    return { status: okStatus, body: { apiVersion: DM_API_VERSION, ...(await fn()) } };
  } catch (e) {
    if (e instanceof DmError) {
      return {
        status: e.status,
        body: { error: e.message, code: e.code },
        headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined,
      };
    }
    throw e;
  }
}

function parseBefore(v: string | null): number | undefined {
  const n = Number(v ?? "");
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : undefined;
}
function parseLimit(v: string | null): number | undefined {
  const n = Number(v ?? "");
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** GET 一覧: { conversations, unread_count }。 */
export function dmListApi(actor: DmActor): Promise<DmApiResult> {
  return run(actor, async () => ({ ...(await listDmConversations(actor)) }));
}

/** GET 1 つの会話: { peer, messages, unread_count, last_read_id, can_send }。 */
export function dmThreadApi(actor: DmActor, peerId: string, sp: URLSearchParams): Promise<DmApiResult> {
  return run(actor, async () => ({
    ...(await listDmMessages(actor, peerId, { before: parseBefore(sp.get("before")), limit: parseLimit(sp.get("limit")) })),
  }));
}

/** POST 送信: { body, client_id? } → 201 { message }。 */
export function dmSendApi(actor: DmActor, peerId: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve({ status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" } });
  return run(actor, async () => ({ message: await sendDm(actor, peerId, input.body, input.client_id ?? input.clientId) }), 201);
}

/** POST 既読: { last_read_id } → { unread_count }。 */
export function dmReadApi(actor: DmActor, peerId: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve({ status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" } });
  return run(actor, async () => ({ ...(await markDmRead(actor, peerId, input.last_read_id ?? input.lastReadId)) }));
}

/** GET 1 件（通知の本文）: { message, peer }。当事者でなければ 404。 */
export function dmMessageApi(actor: DmActor, rawId: string): Promise<DmApiResult> {
  return run(actor, async () => {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new DmError(400, "invalid_request", "不正な ID です");
    const hit = await getDmMessage(actor, id);
    if (!hit) throw new DmError(404, "not_found", "DM が見つかりません");
    return { ...hit };
  });
}
