/* POST / DELETE /api/agent/users/:user_id/mute — この人をタイムラインでミュートする・外す → { apiVersion, muted }。
 * アプリのログインで発行した鍵（app_issued）＋ post だけ。枠は post_light。一覧は GET /api/agent/muted-words の users。
 * その人の投稿・返信はタイムライン・検索・スレッドに出ず、知らせも来ない（プロフィールでは出る）。相手には知らせない。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { setUserMutedApi } from "@/lib/muted-words";
import { agentJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

async function handle(req: NextRequest, muted: boolean, { params }: Ctx) {
  const { id } = await params;
  const out = await withAgent(req, `${muted ? "POST" : "DELETE"} /api/agent/users/:id/mute`, "post", async (ctx) => {
    requireAppIssued(ctx);
    return setUserMutedApi(ctx.email, id, muted);
  }, { lightPost: true });
  return agentJson(out);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return handle(req, true, ctx);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  return handle(req, false, ctx);
}
