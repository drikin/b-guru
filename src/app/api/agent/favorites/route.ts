/* お気に入り（人）。Web の /api/favorites と同じ lib（post-actions.ts・favorites.ts）。メールは出さない。
 *   GET    /api/agent/favorites            → { apiVersion, user_ids: [...] }（新しい順・スコープ read）
 *   POST   /api/agent/favorites { user_id } → { apiVersion, favorited: true }  （冪等）
 *   DELETE /api/agent/favorites { user_id } → { apiVersion, favorited: false } （冪等）
 * 付け外しはアプリのログインで発行した鍵（app_issued）＋ post だけ（外部の鍵は不可・§10.1）。枠は post_light。
 * 自分自身は不可。通知は出さない。お気に入りの人の投稿は GET /api/agent/posts?fav=1。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { listFavoriteIds } from "@/lib/favorites";
import { setFavorite } from "@/lib/post-actions";
import { BAD_JSON, agentActionResult, agentJson, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/favorites", "read", async (ctx) => ({
    status: 200,
    body: { apiVersion: 1, user_ids: await listFavoriteIds(ctx.email) },
    headers: {},
  }));
  return agentJson(out);
}

async function toggle(req: NextRequest, mode: "add" | "remove") {
  const out = await withAgent(req, `${mode === "add" ? "POST" : "DELETE"} /api/agent/favorites`, "post", async (ctx) => {
    requireAppIssued(ctx); // お気に入りの付け外しはアプリの鍵だけ（§10.1）
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    return agentActionResult(await setFavorite(ctx.email, body.user_id, mode));
  }, { lightPost: true });
  return agentJson(out);
}

export async function POST(req: NextRequest) {
  return toggle(req, "add");
}

export async function DELETE(req: NextRequest) {
  return toggle(req, "remove");
}
