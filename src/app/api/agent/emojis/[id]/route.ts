/* DELETE /api/agent/emojis/<id> — カスタム絵文字を消す（その絵文字のリアクションも消える）。スコープ chat・アプリの鍵だけ。
 * 誰でも消せる（オーナー 2026-10-27）。誰が消したかは lib/custom-emoji.ts が残す。→ { ok: true } */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { EmojiError, removeCustomEmoji } from "@/lib/custom-emoji";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const out = await withAgent(
    req,
    "DELETE /api/agent/emojis",
    "chat",
    async (agent) => {
      if (!agent.appIssued) return { status: 403, body: { error: "アプリからだけ使えます", code: "forbidden" }, headers: {} };
      try {
        await removeCustomEmoji(agent.email, id);
        return { status: 200, body: { ok: true }, headers: {} };
      } catch (e) {
        if (e instanceof EmojiError) return { status: e.status, body: { error: e.message, code: e.code }, headers: {} };
        throw e;
      }
    },
    { rateBucket: "post_light" }
  );
  return agentJson(out);
}
