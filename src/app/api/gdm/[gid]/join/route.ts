/* /api/gdm/[gid]/join — 🌐 パブリック DM に参加（Web・ログイン必須）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。
 * 別サイトからのフォーム送信を断るため、ほかの POST と同じく JSON（{}）だけを受け付ける。 */
import { NextRequest } from "next/server";
import { gdmJoinApi } from "@/lib/gdm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function POST(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    if (!(await readJsonBody(req))) return dmJson({ status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" } });
    const { gid } = await rc.params;
    return dmJson(await gdmJoinApi(actor, gid));
  });
}
