/* POST /api/dm/messages/:id/reactions — ✉️ DM へのリアクションを付ける・外す { emoji } → { added, reactions }（Web・ログイン必須）。
 * 当事者でなければ 404。JSON 以外の本文は断る。 */
import { NextRequest } from "next/server";
import { dmReactApi } from "@/lib/dm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { id } = await rc.params;
    return dmJson(await dmReactApi(actor, id, await readJsonBody(req)));
  });
}
