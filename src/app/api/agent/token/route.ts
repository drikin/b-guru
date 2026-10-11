/* POST /api/agent/token — トークン発行（フェーズ1: UI ログイン済みセッションから発行）。
 * デバイスフローはフェーズ2。会員判定は既存 UI ログインと同一ロジック（Ghost isPaidMember）。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { findMemberByEmail, isPaidMember } from "@/lib/ghost";
import { ensureUserId } from "@/lib/user";
import {
  issueAgentToken,
  countActiveTokens,
  MAX_TOKENS_PER_EMAIL,
  AGENT_SCOPES,
  AgentScope,
  AgentAuthError,
} from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json(
      { error: "ログインが必要です", code: "unauthorized" },
      { status: 401, headers: NO_CACHE }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "JSON ボディが必要です", code: "unauthorized" },
      { status: 400, headers: NO_CACHE }
    );
  }

  const deviceName = typeof body?.device_name === "string" ? body.device_name.trim() : "";
  if (!deviceName || deviceName.length > 100) {
    return NextResponse.json(
      { error: "デバイス名を指定してください（100文字以内）", code: "unauthorized" },
      { status: 400, headers: NO_CACHE }
    );
  }

  const scopes = AGENT_SCOPES.filter((s: AgentScope) =>
    Array.isArray(body?.scopes) ? body.scopes.includes(s) : false
  );

  try {
    // 会員判定: 既存 UI ログイン（/api/auth/request）と同一の Ghost ロジックを再利用。
    const member = await findMemberByEmail(email);
    if (!member || !isPaidMember(member)) {
      throw new AgentAuthError(403, {
        error: "BSM 会員資格が確認できません",
        code: "membership_ended",
        hint: "backspace.fm で会員状況をご確認ください",
      });
    }

    if ((await countActiveTokens(email)) >= MAX_TOKENS_PER_EMAIL) {
      return NextResponse.json(
        {
          error: `発行できるトークンは ${MAX_TOKENS_PER_EMAIL} 本までです`,
          code: "forbidden",
          hint: "不要なデバイスを失効してから再試行してください",
        },
        { status: 400, headers: NO_CACHE }
      );
    }

    const issued = await issueAgentToken({ email, deviceName, scopes });
    const userId = await ensureUserId(email);
    return NextResponse.json(
      { token: issued.token, expiresAt: issued.expiresAt, userId, scopes: issued.scopes },
      { status: 201, headers: NO_CACHE }
    );
  } catch (e: any) {
    if (e instanceof AgentAuthError) {
      return NextResponse.json(e.body, { status: e.status, headers: NO_CACHE });
    }
    console.error("[agent:token] issue failed:", e?.message);
    return NextResponse.json(
      { error: "トークン発行に失敗しました", code: "unauthorized" },
      { status: 500, headers: NO_CACHE }
    );
  }
}
