/* /api/gdm/[gid] — 👥 グループ DM（Web・ログイン必須）。中身はアプリの /api/agent/gdm と同じ lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { gdmThreadApi, gdmUpdateApi } from "@/lib/gdm-api";
import { dmJson, guarded, readBody, UNAUTHORIZED, webDmActor } from "../../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function GET(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid } = await rc.params;
    return dmJson(await gdmThreadApi(actor, gid, req.nextUrl.searchParams));
  });
}

export async function PATCH(req: NextRequest, rc: RC) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    const { gid } = await rc.params;
    return dmJson(await gdmUpdateApi(actor, gid, await readBody(req)));
  });
}
