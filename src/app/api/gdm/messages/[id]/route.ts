/* /api/gdm/messages/[id] — 👥 グループ DM（Web・ログイン必須）。中身はアプリの /api/agent/gdm と同じ lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { gdmMessageApi } from "@/lib/gdm-api";
import { dmJson, guarded, UNAUTHORIZED, webDmActor } from "../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { id } = await rc.params;
    return dmJson(await gdmMessageApi(actor, id));
  });
}
