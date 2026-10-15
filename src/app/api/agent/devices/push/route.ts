/* /api/agent/devices/push — ネイティブアプリ（iPhone/iPad）の APNs 端末トークン登録（スコープ read）。
 *   POST   { token, environment: "production"|"sandbox", platform?, notify_mode?: "all"|"mentions",
 *            quiet_hours?: boolean } → この端末にプッシュを送る（設定の変更も同じ POST）
 *   DELETE { token }                                                   → 送らない（ログアウト時）
 * 端末はこの agent token に紐付く。トークンが失効・期限切れになれば送られない。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { APNS_TOKEN_RE } from "@/lib/apns";
import { normalizeEnvironment, normalizeNotifyMode, registerPushDevice, unregisterPushDevice } from "@/lib/push-devices";
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
    if (!APNS_TOKEN_RE.test(token) || !environment) {
      return { status: 400, body: { error: "token と environment が不正です", code: "invalid_request" }, headers: {} };
    }
    const platform = b?.platform === "ipados" ? "ipados" : "ios";
    await registerPushDevice({
      email: ctx.email,
      agentTokenId: ctx.tokenId,
      apnsToken: token,
      environment,
      platform,
      notifyMode: normalizeNotifyMode(b?.notify_mode),
      quietHours: b?.quiet_hours !== false,
    });
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ok: true }, headers: {} };
  });
  return agentJson(out);
}

export async function DELETE(req: NextRequest) {
  const out = await withAgent(req, "DELETE /api/agent/devices/push", "read", async (ctx) => {
    const b = await readBody(req);
    const token = typeof b?.token === "string" ? b.token.trim() : "";
    if (!APNS_TOKEN_RE.test(token)) {
      return { status: 400, body: { error: "token が不正です", code: "invalid_request" }, headers: {} };
    }
    await unregisterPushDevice(ctx.email, token);
    return { status: 200, body: { apiVersion: AGENT_API_VERSION, ok: true }, headers: {} };
  });
  return agentJson(out);
}
