/* 👥 グループ DM の API の中身（Web の /api/gdm/** とアプリの /api/agent/gdm/** で共通、docs/group-dm-spec.md）。
 * 認証はルートが済ませ、ここには本人（DmActor）だけが来る。GROUP_DM_ENABLED の対象でない人には 404。 */
import { DmError, ensureDmSweeper, type DmActor } from "./dm";
import type { DmApiResult } from "./dm-api";
import {
  addMembers,
  createGroup,
  gdmEnabledFor,
  getGroupMessage,
  getGroupThread,
  listGroups,
  markGroupRead,
  removeMember,
  removeGroupPhoto,
  setGroupPhoto,
  assertCanSetPhoto,
  GDM_PHOTO_MAX_BYTES,
  sendGroupMessage,
  updateGroup,
} from "./gdm";

export const GDM_API_VERSION = 1;

const NOT_ENABLED: DmApiResult = { status: 404, body: { error: "グループ DM はまだ使えません", code: "not_found" } };
const NEED_JSON: DmApiResult = { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" } };

async function run(actor: DmActor, fn: () => Promise<Record<string, unknown>>, okStatus = 200): Promise<DmApiResult> {
  if (!gdmEnabledFor(actor.email)) return NOT_ENABLED;
  ensureDmSweeper();
  try {
    return { status: okStatus, body: { apiVersion: GDM_API_VERSION, ...(await fn()) } };
  } catch (e) {
    if (e instanceof DmError) {
      return { status: e.status, body: { error: e.message, code: e.code }, headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined };
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

/** GET 一覧: { groups, group_unread_count }。 */
export const gdmListApi = (actor: DmActor) => run(actor, async () => ({ ...(await listGroups(actor)) }));

/** POST 作る: { name?, member_ids } → 201 { group }。 */
export function gdmCreateApi(actor: DmActor, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve(NEED_JSON);
  return run(actor, async () => ({ group: await createGroup(actor, input.name, input.member_ids ?? input.memberIds) }), 201);
}

/** GET 1 つのグループ: { group, messages, unread_count, last_read_id, can_send }。 */
export const gdmThreadApi = (actor: DmActor, gid: string, sp: URLSearchParams) =>
  run(actor, async () => ({ ...(await getGroupThread(actor, gid, { before: parseBefore(sp.get("before")), limit: parseLimit(sp.get("limit")) })) }));

/** PATCH: { name?, muted? } → { group }。 */
export function gdmUpdateApi(actor: DmActor, gid: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve(NEED_JSON);
  return run(actor, async () => ({ group: await updateGroup(actor, gid, input) }));
}

/** POST 送る: { body, client_id? } → 201 { message }。 */
export function gdmSendApi(actor: DmActor, gid: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve(NEED_JSON);
  return run(actor, async () => ({ message: await sendGroupMessage(actor, gid, input.body, input.client_id ?? input.clientId, input.images) }), 201);
}

/** POST 既読: { last_read_id } → { unread_count, group_unread_count }。 */
export function gdmReadApi(actor: DmActor, gid: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve(NEED_JSON);
  return run(actor, async () => ({ ...(await markGroupRead(actor, gid, input.last_read_id ?? input.lastReadId)) }));
}

/** POST 追加: { user_ids } → { group }。 */
export function gdmAddMembersApi(actor: DmActor, gid: string, input: Record<string, unknown> | null): Promise<DmApiResult> {
  if (!input) return Promise.resolve(NEED_JSON);
  return run(actor, async () => ({ group: await addMembers(actor, gid, input.user_ids ?? input.userIds) }));
}

/** DELETE 外す・抜ける → { ok }。 */
export const gdmRemoveMemberApi = (actor: DmActor, gid: string, userId: string) =>
  run(actor, async () => ({ ...(await removeMember(actor, gid, userId)) }));

/** GET 1 件（通知の本文）: { message, group }。メンバーでなければ 404。 */
export const gdmMessageApi = (actor: DmActor, rawId: string) =>
  run(actor, async () => {
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new DmError(400, "invalid_request", "不正な ID です");
    const hit = await getGroupMessage(actor, id);
    if (!hit) throw new DmError(404, "not_found", "グループ DM が見つかりません");
    return { ...hit };
  });

/** POST 写真（multipart の photo）→ { group }。 */
export async function gdmSetPhotoApi(actor: DmActor, gid: string, req: Request): Promise<DmApiResult> {
  // 本文を読む前に: 大きさ（Content-Length が無い・大きすぎるものは断る）と、メンバーか
  const len = Number(req.headers.get("content-length") ?? "");
  if (!Number.isFinite(len) || len <= 0 || len > GDM_PHOTO_MAX_BYTES + 1024 * 1024) {
    return { status: 413, body: { error: "写真が大きすぎます", code: "invalid_request" } };
  }
  const pre = await run(actor, async () => {
    await assertCanSetPhoto(actor, gid);
    return {};
  });
  if (pre.status !== 200) return pre;
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("photo");
    file = f instanceof File ? f : null;
  } catch {
    file = null;
  }
  if (!file) return { status: 400, body: { error: "写真を選んでください", code: "invalid_request" } };
  const buf = Buffer.from(await file.arrayBuffer());
  return run(actor, async () => ({ group: await setGroupPhoto(actor, gid, buf, file.type) }));
}

/** DELETE 写真 → { group }。 */
export const gdmRemovePhotoApi = (actor: DmActor, gid: string) => run(actor, async () => ({ group: await removeGroupPhoto(actor, gid) }));
