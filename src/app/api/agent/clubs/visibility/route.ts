/* 部活の表示・非表示（本人の設定。Web の /api/clubs/visibility と同じ表）。
 *   GET /api/agent/clubs/visibility                      → { apiVersion, hidden: [key...] }（スコープ read）
 *   PUT /api/agent/clubs/visibility { club, hidden }     → { apiVersion, club, hidden }
 * 切り替えはアプリのログインで発行した鍵（app_issued）＋ post だけ。枠は post_light。
 * 隠した部活のほかの人の投稿はタイムラインに出ない（自分の投稿は出る）。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { getVisibilityApi, setVisibilityApi } from "@/lib/club-visibility-api";
import { BAD_JSON, agentJson, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/clubs/visibility", "read", (ctx) => getVisibilityApi(ctx));
  return agentJson(out);
}

export async function PUT(req: NextRequest) {
  const out = await withAgent(req, "PUT /api/agent/clubs/visibility", "post", async (ctx) => {
    requireAppIssued(ctx);
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    return setVisibilityApi(ctx, body);
  }, { lightPost: true });
  return agentJson(out);
}
