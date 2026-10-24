/* POST /api/agent/chat/beagle/ask { question_id } — 🐶 自分の @ビーグル の質問に、サーバのビーグル（さくらの AI Engine）が
 * すぐ答える（lib/beagle-server.ts）。iPhone・Mac はあいさつ・雑談以外をこれで頼む（端末内 AI より賢い）。
 * 答えはチャットに流れる（応答は 202、答えた・答えなかったは stream で）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { answerBeagleQuestion, beagleServerEnabledFor } from "@/lib/beagle-server";
import { agentJson, parsePositiveId } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat/beagle/ask", "chat", async (ctx) => {
    if (!beagleServerEnabledFor(ctx.email)) return { status: 404, body: { error: "この機能は使えません", code: "not_enabled" }, headers: {} };
    let input: { question_id?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const id = typeof input?.question_id === "number" ? parsePositiveId(String(input.question_id)) : null;
    if (!id) return { status: 400, body: { error: "question_id が必要です", code: "invalid_request" }, headers: {} };
    // 自分の質問か・答え済みか・上限は answerBeagleQuestion が見る。待たずに返す（答えは stream で届く）。
    void answerBeagleQuestion(id, ctx.email).catch((e) => console.error("beagle ask:", (e as Error)?.message));
    return { status: 202, body: { apiVersion: AGENT_API_VERSION, accepted: id }, headers: {} };
  });
  return agentJson(out);
}
