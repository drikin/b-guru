/* PATCH /api/agent/chat/:id — 自分のメッセージの編集（スコープ chat）。
 * Web の PATCH /api/chat/[id] と同じ lib を通る（本人のみ・24時間以内）。
 * 削除はモデレーション（管理者）なので Web のみ。 */
import { NextRequest } from "next/server";
import { editChatMessageAndBroadcast, normalizeChatBody } from "@/lib/chat";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION, toAgentChatDto } from "@/lib/agent-chat";
import { agentJson, parsePositiveId } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const out = await withAgent(req, "PATCH /api/agent/chat/:id", "chat", async (ctx) => {
    const id = parsePositiveId((await rc.params).id);
    if (!id) return { status: 400, body: { error: "不正な ID です", code: "invalid_request" }, headers: {} };
    let input: { body?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const checked = normalizeChatBody(input?.body);
    if (!checked.ok) {
      return { status: 400, body: { error: "本文が不正です", code: "invalid_request" }, headers: {} };
    }
    const updated = await editChatMessageAndBroadcast(id, ctx.email, checked.body);
    if (!updated) {
      return {
        status: 403,
        body: { error: "編集できません（本人のメッセージで24時間以内のみ）", code: "forbidden" },
        headers: {},
      };
    }
    const dto = toAgentChatDto(updated, { userId: ctx.userId, mentionNames: new Set() });
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, message: dto }, headers: {} };
  });
  return agentJson(out);
}
