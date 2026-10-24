/* POST /api/dm/:userId/read — ✉️ 簡易 DM の既読を進める { last_read_id }（Web・ログイン必須）。 */
import { NextRequest } from "next/server";
import { dmReadApi } from "@/lib/dm-api";
import { dmJson, guarded, readBody, UNAUTHORIZED, webDmActor } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ userId: string }> }) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { userId } = await rc.params;
    return dmJson(await dmReadApi(actor, userId, await readBody(req)));
  });
}
