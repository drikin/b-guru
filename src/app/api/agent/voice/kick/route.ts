/* POST /api/agent/voice/kick — ボイスルームから退出させる。スコープ voice。
 *   { user_id, ban?: boolean, reason?: string }
 * 退出は管理者と、今の回を開いた人ができる。ban（以後入室禁止）は管理者だけ。
 * LiveKit の RemoveParticipant で即時に切るので、トークンの期限を待たない。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { isAdmin } from "@/lib/admin";
import { livekitConfig } from "@/lib/livekit";
import { userIdToEmail } from "@/lib/user";
import { banFromVoice, canModerate, refreshVoiceState, removeParticipant, voiceEnabledFor } from "@/lib/voice";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/voice/kick", "voice", async (ctx) => {
    const cfg = livekitConfig();
    if (!cfg || !voiceEnabledFor(ctx.email)) {
      return { status: 404, body: { error: "ボイスルームは使えません", code: "not_found" }, headers: {} };
    }
    let input: { user_id?: unknown; ban?: unknown; reason?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const target = typeof input.user_id === "string" ? input.user_id.trim() : "";
    if (!target || target.length > 64) {
      return { status: 400, body: { error: "user_id を指定してください", code: "invalid_request" }, headers: {} };
    }
    if (target === ctx.userId) {
      return { status: 400, body: { error: "自分は退出させられません", code: "invalid_request" }, headers: {} };
    }
    if (!(await canModerate(ctx.email, ctx.userId))) {
      return { status: 403, body: { error: "この操作はできません", code: "forbidden" }, headers: {} };
    }
    const ban = input.ban === true;
    if (ban && !isAdmin(ctx.email)) {
      return { status: 403, body: { error: "入室禁止は管理者だけができます", code: "forbidden" }, headers: {} };
    }
    const targetEmail = await userIdToEmail(target);
    if (targetEmail && isAdmin(targetEmail) && !isAdmin(ctx.email)) {
      return { status: 403, body: { error: "この操作はできません", code: "forbidden" }, headers: {} };
    }
    if (ban) {
      if (!targetEmail) {
        return { status: 404, body: { error: "会員が見つかりません", code: "not_found" }, headers: {} };
      }
      const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : null;
      await banFromVoice(targetEmail, ctx.email, reason);
    }
    await removeParticipant(cfg, target);
    await refreshVoiceState().catch(() => {});
    return { status: 200, body: { ok: true, banned: ban }, headers: {} };
  });
  return agentJson(out);
}
