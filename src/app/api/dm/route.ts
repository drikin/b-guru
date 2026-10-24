/* GET /api/dm — ✉️ 簡易 DM の会話の一覧と未読の合計（Web・ログイン必須）。DM_ENABLED の対象外は 404。 */
import { dmListApi } from "@/lib/dm-api";
import { dmJson, guarded, UNAUTHORIZED, webDmActor } from "./_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    return dmJson(await dmListApi(actor));
  });
}
