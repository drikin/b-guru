/* /api/gdm/[gid]/messages — 👥 グループ DM（Web・ログイン必須）。中身はアプリの /api/agent/gdm と同じ lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { gdmSendApi } from "@/lib/gdm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function POST(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid } = await rc.params;
    return dmJson(await gdmSendApi(actor, gid, await readJsonBody(req)));
  });
}
