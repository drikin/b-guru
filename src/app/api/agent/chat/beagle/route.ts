/* /api/agent/chat/beagle — 🐶 端末内 AI のビーグル（lib/beagle-ondevice.ts）。
 *   POST   { question_id, body, app? } : 自分が 10 分以内に書いた @ビーグル の質問に、自分の端末（iOS 26 /
 *            macOS 26 の Foundation Models）が作った答えを、ビーグル（〇〇さんの端末）として全員に出す。
 *            201 { message } / 409 もう答えた / 429 上限 / 403 他人の質問 / 404 使えない・質問がない。
 *   DELETE ?id= : 自分の端末が出した答えを消す。
 * アプリのログインで発行した鍵（app_issued）＋ スコープ chat だけ（外部の AI エージェントの鍵は不可）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION, toAgentChatDto } from "@/lib/agent-chat";
import { deleteBeagleAiReply, postBeagleAiReply } from "@/lib/beagle-ondevice";
import { agentJson, parsePositiveId } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const notApp = { status: 403, body: { error: "アプリからだけ使えます", code: "forbidden" }, headers: {} };

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat/beagle", "chat", async (ctx) => {
    if (!ctx.appIssued) return notApp;
    let input: { question_id?: unknown; body?: unknown; app?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const questionId = typeof input?.question_id === "number" ? parsePositiveId(String(input.question_id)) : null;
    if (!questionId) return { status: 400, body: { error: "question_id が必要です", code: "invalid_request" }, headers: {} };
    const r = await postBeagleAiReply({ email: ctx.email, questionId, body: input?.body, app: input?.app });
    if (!r.ok) return { status: r.status, body: { error: r.error, code: r.code }, headers: {} };
    const dto = toAgentChatDto(r.message, { userId: ctx.userId, mentionNames: new Set() });
    return { status: 201, body: { apiVersion: AGENT_API_VERSION, message: dto }, headers: {} };
  });
  return agentJson(out);
}

export async function DELETE(req: NextRequest) {
  const out = await withAgent(req, "DELETE /api/agent/chat/beagle", "chat", async (ctx) => {
    if (!ctx.appIssued) return notApp;
    const id = parsePositiveId(req.nextUrl.searchParams.get("id") ?? "");
    if (!id) return { status: 400, body: { error: "id が必要です", code: "invalid_request" }, headers: {} };
    const ok = await deleteBeagleAiReply(ctx.email, id);
    if (!ok) return { status: 404, body: { error: "消せる答えが見つかりません", code: "not_found" }, headers: {} };
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, deleted: id }, headers: {} };
  });
  return agentJson(out);
}
