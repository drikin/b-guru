/* 🍻 オフ会の HTTP（Web の /api/offkai/* とアプリの /api/agent/offkai/* で共用）。認証は呼び出し側。
 * ここは道順・入力・応答の形だけ（docs/offkai-spec.md の API の表）。
 *
 *   GET    ""                    状態 → { enabled, can, current, listeners, archive }（?before=<id> でアーカイブの続き）
 *   POST   ""        {title}     始める → { event }（ほかが開催中なら 409 busy と current）
 *   POST   end                   終える → { event }
 *   POST   speak     {on}        話す（後勝ち）・やめる → { event, token, url, room, can_speak }
 *   POST   token                 部屋に入る鍵 → { token, url, room, can_speak }
 *   GET    <id>                  1 件 → { event }
 *   GET    <id>/photos           アルバム（古い順）?after=<photoId>&limit= → { photos, next_after }
 *   POST   photos    multipart   写真（images 4 枚まで・caption）→ { photos }
 *   DELETE photos/<photoId>      自分の写真を消す → { ok }
 * 応答: { apiVersion, ... }。エラーは { error, code }。 */
import { AGENT_API_VERSION } from "./agent-chat";
import { handleUpload } from "./upload";
import { readJsonLimited } from "./minigame-api";
import {
  addPhotos,
  deletePhoto,
  end,
  ensureOffkaiSweeper,
  getEvent,
  getState,
  listPhotos,
  OffkaiError,
  rateOk,
  speak,
  start,
  token,
  type Actor,
} from "./offkai";

export type OffkaiHttpOut = { status: number; body: unknown };

export function notFound(): OffkaiHttpOut {
  return { status: 404, body: { error: "見つかりません", code: "not_found" } };
}

const id = (v: string | undefined): number | null => {
  if (!v || !/^\d{1,9}$/.test(v)) return null;
  const n = Number(v);
  return n > 0 ? n : null;
};

const ok = (body: Record<string, unknown>, status = 200): OffkaiHttpOut => ({ status, body: { apiVersion: AGENT_API_VERSION, ...body } });

export async function handleOffkai(req: Request, path: string[], actor: Actor): Promise<OffkaiHttpOut> {
  ensureOffkaiSweeper();
  const method = req.method;
  const url = new URL(req.url);
  try {
    const [a, b, c] = path;
    if (c) return notFound();
    if (!a) {
      if (method === "GET") return ok(await getState(actor, id(url.searchParams.get("before") ?? undefined)));
      if (method === "POST") return ok({ event: await start(actor, (await body(req)) ?? {}) }, 201);
      return notFound();
    }
    if (a === "end" && !b && method === "POST") return ok({ event: await end(actor) });
    if (a === "speak" && !b && method === "POST") {
      const input = (await body(req)) ?? {};
      return ok(await speak(actor, input.on !== false));
    }
    if (a === "token" && !b && method === "POST") return ok(await token(actor));
    if (a === "photos") {
      if (!b && method === "POST") return await upload(req, actor);
      const pid = id(b);
      if (pid && method === "DELETE") {
        await deletePhoto(actor, pid);
        return ok({ ok: true });
      }
      return notFound();
    }
    const eid = id(a);
    if (eid && method === "GET") {
      if (!b) return ok({ event: await getEvent(actor, eid) });
      if (b === "photos") return ok(await listPhotos(actor, eid, id(url.searchParams.get("after") ?? undefined), url.searchParams.get("limit")));
    }
    return notFound();
  } catch (e) {
    if (e instanceof OffkaiError) return { status: e.status, body: { error: e.message, code: e.code, ...e.extra } };
    console.error("offkai:", (e as Error)?.message);
    return { status: 500, body: { error: "うまくいきませんでした", code: "internal" } };
  }
}

async function body(req: Request): Promise<Record<string, unknown> | null> {
  const b = await readJsonLimited(req);
  if (b === "too_large") throw new OffkaiError(413, "too_large", "大きすぎます");
  return b;
}

async function upload(req: Request, actor: Actor): Promise<OffkaiHttpOut> {
  if (!rateOk("photo", actor.userId)) return { status: 429, body: { error: "写真が多すぎます。少し待ってください", code: "rate_limited" } };
  let caption: unknown = "";
  const res = await handleUpload(req, actor.email, { offkai: true, onForm: (f) => (caption = f.get("caption")) });
  const j = (await res.json().catch(() => ({}))) as { urls?: string[]; error?: string };
  if (res.status !== 201 || !Array.isArray(j.urls)) {
    return { status: res.status >= 400 ? res.status : 400, body: { error: j.error ?? "写真を保存できませんでした", code: "invalid_request" } };
  }
  return ok({ photos: await addPhotos(actor, j.urls, caption) }, 201);
}
