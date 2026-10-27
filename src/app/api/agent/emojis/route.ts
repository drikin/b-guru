/* /api/agent/emojis — カスタム絵文字（リアクションのピッカー用）。Web の /api/emojis と同じ lib。登録した人（メール）は出さない。
 *   GET  （スコープ read）→ { apiVersion, emojis: [{ id, name, image_url }] }。リアクションには ":name:" を送る。
 *   POST （multipart: name・image、スコープ chat・アプリの鍵だけ）→ { apiVersion, emoji: { id, name, image_url } }
 *   削除は DELETE /api/agent/emojis/<id>。誰でも登録・削除できる（オーナー 2026-10-27）。決まりは lib/custom-emoji.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { listCustomEmojis } from "@/lib/reactions";
import { EmojiError, registerCustomEmoji } from "@/lib/custom-emoji";
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

export async function POST(req: NextRequest) {
  const out = await withAgent(
    req,
    "POST /api/agent/emojis",
    "chat",
    async (agent) => {
      if (!agent.appIssued) return { status: 403, body: { error: "アプリからだけ使えます", code: "forbidden" }, headers: {} };
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return { status: 400, body: { error: "不正なリクエスト", code: "invalid_request" }, headers: {} };
      }
      try {
        const e = await registerCustomEmoji(agent.email, form.get("name"), form.get("image"));
        return { status: 201, body: { apiVersion: 1, emoji: { id: e.id, name: e.name, image_url: e.imageUrl } }, headers: {} };
      } catch (e) {
        if (e instanceof EmojiError) return { status: e.status, body: { error: e.message, code: e.code }, headers: {} };
        throw e;
      }
    },
    { rateBucket: "post_light" }
  );
  return agentJson(out);
}
