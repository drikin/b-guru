/* /api/gdm/[gid]/members/[userId] — 👥 グループ DM（Web・ログイン必須）。中身はアプリの /api/agent/gdm と同じ lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { gdmRemoveMemberApi } from "@/lib/gdm-api";
import { dmJson, guarded, UNAUTHORIZED, webDmActor } from "../../../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string; userId: string }> };

export async function DELETE(_req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid, userId } = await rc.params;
    return dmJson(await gdmRemoveMemberApi(actor, gid, userId));
  });
}
