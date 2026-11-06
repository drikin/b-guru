/* /api/gdm/ — 👥 グループ DM（Web・ログイン必須）。中身はアプリの /api/agent/gdm と同じ lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { gdmCreateApi, gdmListApi } from "@/lib/gdm-api";
import { dmJson, guarded, readJsonBody, UNAUTHORIZED, webDmActor } from "../dm/_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export async function GET() {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    return dmJson(await gdmListApi(actor));
  });
}

export async function POST(req: NextRequest) {
  return guarded(async () => {
    const actor = await webDmActor();
    if (!actor) return UNAUTHORIZED();
    return dmJson(await gdmCreateApi(actor, await readJsonBody(req)));
  });
}
