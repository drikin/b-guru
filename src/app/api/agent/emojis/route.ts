/* GET /api/agent/emojis — カスタム絵文字の一覧（リアクションのピッカー用・スコープ read）。
 * Web の /api/emojis と同じ lib（listCustomEmojis）。登録はしない（Web だけ）。登録した人（メール）は出さない。
 *   → { apiVersion, emojis: [{ id, name, image_url }] }。リアクションには ":name:" を送る。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { listCustomEmojis } from "@/lib/reactions";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/emojis", "read", async () => ({
    status: 200,
    body: {
      apiVersion: 1,
      emojis: (await listCustomEmojis()).map((e) => ({ id: e.id, name: e.name, image_url: e.imageUrl })),
    },
    headers: {},
  }));
  return agentJson(out);
}
