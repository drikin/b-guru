/* GET /api/agent/settings-devices — ログインユーザーのトークン（デバイス）一覧。
 * UI（/settings/agent）専用・Cookie セッション認証。Bearer トークンでは提供しない。 */
import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { listAgentTokens } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です", code: "unauthorized" }, { status: 401, headers: NO_CACHE });
  }
  const devices = await listAgentTokens(email);
  return NextResponse.json({ devices }, { headers: NO_CACHE });
}
