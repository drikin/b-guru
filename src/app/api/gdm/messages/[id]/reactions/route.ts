/* POST /api/gdm/messages/:id/reactions — 👥 グループ DM の発言へのリアクション { emoji } → { added, reactions }（Web・ログイン必須）。
 * メンバーでなければ（入る前の発言も）404。JSON 以外の本文は断る。 */
import { NextRequest } from "next/server";
import { gdmReactApi } from "@/lib/gdm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { id } = await rc.params;
    return dmJson(await gdmReactApi(actor, id, await readJsonBody(req)));
  });
}
