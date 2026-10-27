/* /api/dm/:userId — ✉️ 簡易 DM の 1 つの会話（Web・ログイン必須）。
 *   GET  : 30 日以内のやりとり・未読・相手
 *   POST : 送る { body, client_id? }（送り主はセッションの本人だけ）
 * 中身はアプリの /api/agent/dm/:userId と同じ lib/dm-api.ts。 */
import { NextRequest } from "next/server";
import { dmSendApi, dmThreadApi } from "@/lib/dm-api";
import { dmJson, guarded, readBody, UNAUTHORIZED, webDmActor } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ userId: string }> };

export async function GET(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { userId } = await rc.params;
    return dmJson(await dmThreadApi(actor, userId, req.nextUrl.searchParams));
  });
}

export async function POST(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { userId } = await rc.params;
    return dmJson(await dmSendApi(actor, userId, await readBody(req)));
  });
}
