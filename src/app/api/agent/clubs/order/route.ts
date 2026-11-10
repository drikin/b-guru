/* 部活一覧の自分の並び順（アプリの部活一覧。lib/club-user-order.ts）。
 *   GET /api/agent/clubs/order                 → { apiVersion, order: [key...] }（スコープ read。並べていなければ []）
 *   PUT /api/agent/clubs/order { order: [...] } → { apiVersion, order }（丸ごと置き換え。[] でカタログ順に戻す）
 * 書くのはアプリのログインで発行した鍵（app_issued）＋ post だけ。枠は post_light。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { getClubOrder, normalizeOrder, setClubOrder } from "@/lib/club-user-order";
import { BAD_JSON, agentJson, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/clubs/order", "read", async (ctx) => ({
    status: 200,
    body: { apiVersion: 1, order: await getClubOrder(ctx.email) },
    headers: {},
  }));
  return agentJson(out);
}

export async function PUT(req: NextRequest) {
  const out = await withAgent(req, "PUT /api/agent/clubs/order", "post", async (ctx) => {
    requireAppIssued(ctx);
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    const order = normalizeOrder(body.order);
    if (!order) return { status: 400, body: { error: "order は部活キーの配列です", code: "invalid_request" }, headers: {} };
    await setClubOrder(ctx.email, order);
    return { status: 200, body: { apiVersion: 1, order }, headers: {} };
  }, { lightPost: true });
  return agentJson(out);
}
