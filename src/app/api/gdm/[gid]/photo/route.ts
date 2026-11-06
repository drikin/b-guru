/* /api/gdm/:gid/photo — 👥 グループの写真（docs/group-dm-spec.md）。
 *   GET    : 写真（メンバーだけ。Web はクッキー、アプリは鍵の Bearer。lib/download-auth.ts の mediaAuthEmail）
 *   POST   : 設定・取り替え（Web、multipart の photo。別サイトからのフォーム送信を断るためオリジンを確かめる）
 *   DELETE : 外す */
import { NextRequest } from "next/server";
import { mediaAuthEmail } from "@/lib/download-auth";
import { gdmEnabledFor, readGroupPhoto } from "@/lib/gdm";
import { gdmRemovePhotoApi, gdmSetPhotoApi } from "@/lib/gdm-api";
import { sameOrigin } from "../../../auth/_lib";
import { dmJson, guarded, UNAUTHORIZED, webDmActor } from "../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function GET(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const email = await mediaAuthEmail(req);
    if (!email) return UNAUTHORIZED();
    const { gid } = await rc.params;
    const data = gdmEnabledFor(email) ? await readGroupPhoto(email, gid).catch(() => null) : null;
    if (!data) return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    // URL の ?v= はファイルごとに変わるので長く持ってよい。メンバーだけのものなので共有キャッシュには置かない。
    return new Response(new Uint8Array(data), {
      status: 200,
      headers: { "Content-Type": "image/webp", "Cache-Control": "private, max-age=604800", "X-Content-Type-Options": "nosniff" },
    });
  });
}

export async function POST(req: NextRequest, rc: RC) {
  return guarded(async () => {
    if (!sameOrigin(req)) return new Response(JSON.stringify({ error: "オリジンが不正です", code: "forbidden" }), { status: 403 });
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid } = await rc.params;
    return dmJson(await gdmSetPhotoApi(actor, gid, req));
  });
}

export async function DELETE(req: NextRequest, rc: RC) {
  return guarded(async () => {
    if (!sameOrigin(req)) return new Response(JSON.stringify({ error: "オリジンが不正です", code: "forbidden" }), { status: 403 });
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid } = await rc.params;
    return dmJson(await gdmRemovePhotoApi(actor, gid));
  });
}
