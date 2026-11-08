/* PATCH /api/dm/messages/:id — ✉️ 自分の DM を直す { body } → { message }（Web・ログイン必須）。
 * 中身はアプリの /api/agent/dm/messages/:id と同じ lib/dm-api.ts。JSON 以外の本文は断る（別サイトからのフォーム送信よけ）。 */
import { NextRequest } from "next/server";
import { dmEditApi } from "@/lib/dm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { id } = await rc.params;
    return dmJson(await dmEditApi(actor, id, await readJsonBody(req)));
  });
}
