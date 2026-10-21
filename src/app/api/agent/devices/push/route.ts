/* /api/agent/devices/push — ネイティブアプリの端末トークン登録（スコープ read）。
 *   iPhone/iPad は APNs（environment "production"|"sandbox"）、Android は FCM（environment "fcm"）。
 *   POST   { token, environment: "production"|"sandbox"|"fcm", platform?, notify_mode?: "all"|"mentions",
 *            quiet_hours?: boolean, notify_timeline?: boolean, notify_shogi?: boolean } → この端末にプッシュを送る（設定の変更も同じ POST）
 *   notify_shogi: ☗ 将棋の通知（shogi_offer / shogi_turn）に対応したアプリだけが true を送る（既定 false）。
 *   DELETE { token }                                                   → 送らない（ログアウト時）
 * 端末はこの agent token に紐付く。トークンが失効・期限切れになれば送られない。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { APNS_TOKEN_RE } from "@/lib/apns";
import { FCM_TOKEN_RE } from "@/lib/fcm";
import {
  normalizeEnvironment,
  normalizeNotifyMode,
  registerPushDevice,
  unregisterPushDevice,
  validPushToken,
} from "@/lib/push-devices";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/devices/push", "read", async (ctx) => {
    const b = await readBody(req);
    const token = typeof b?.token === "string" ? b.token.trim() : "";
    const environment = normalizeEnvironment(b?.environment);
    if (!environment || !validPushToken(token, environment)) {
      return { status: 400, body: { error: "token と environment が不正です", code: "invalid_request" }, headers: {} };
    }
    const platform = environment === "fcm" ? "android" : b?.platform === "ipados" ? "ipados" : "ios";
    await registerPushDevice({
      email: ctx.email,
      agentTokenId: ctx.tokenId,
      apnsToken: token,
      environment,
      platform,
      notifyMode: normalizeNotifyMode(b?.notify_mode),
      quietHours: b?.quiet_hours !== false,
      // Only when sent: older apps re-register without it and must not switch it off.
      notifyTimeline: typeof b?.notify_timeline === "boolean" ? b.notify_timeline : undefined,
      notifyShogi: typeof b?.notify_shogi === "boolean" ? b.notify_shogi : undefined,
    });
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ok: true }, headers: {} };
  });
  return agentJson(out);
}

export async function DELETE(req: NextRequest) {
  const out = await withAgent(req, "DELETE /api/agent/devices/push", "read", async (ctx) => {
    const b = await readBody(req);
    const token = typeof b?.token === "string" ? b.token.trim() : "";
    if (!APNS_TOKEN_RE.test(token) && !FCM_TOKEN_RE.test(token)) {
      return { status: 400, body: { error: "token が不正です", code: "invalid_request" }, headers: {} };
    }
    await unregisterPushDevice(ctx.email, token);
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ok: true }, headers: {} };
  });
  return agentJson(out);
}
