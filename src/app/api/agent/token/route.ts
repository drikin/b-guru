/* POST /api/agent/token — トークン発行（フェーズ1: UI ログイン済みセッションから発行）。
 * デバイスフローはフェーズ2。会員判定は既存 UI ログインと同一ロジック（Ghost isPaidMember）。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { findMemberByEmail, isPaidMember } from "@/lib/ghost";
import { ensureUserId } from "@/lib/user";
import {
  issueAgentToken,
  countActiveTokens,
  revokeTokensByDeviceName,
  MAX_TOKENS_PER_EMAIL,
  AGENT_SCOPES,
  AgentScope,
  AgentAuthError,
} from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  // CSRF 対策: SameSite=lax の Cookie を使う state-changing ルートのため
  //   同一オリジン（または API クライアントの直接呼び出し=Origin なし）のみ許可。
  //   cross-site の form POST（text/plain で JSON を偽装する手口含む）を遮断する。
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (origin) {
    const originHost = new URL(origin).host;
    if (originHost !== req.headers.get("host")) {
      return NextResponse.json(
        { error: "オリジンが不正です", code: "forbidden" },
        { status: 403, headers: NO_CACHE }
      );
    }
  } else if (site && site !== "same-origin" && site !== "none") {
    return NextResponse.json(
      { error: "オリジンが不正です", code: "forbidden" },
      { status: 403, headers: NO_CACHE }
    );
  }

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
      { error: "JSON ボディが必要です", code: "invalid_request" },
      { status: 400, headers: NO_CACHE }
    );
  }

  const deviceName = typeof body?.device_name === "string" ? body.device_name.trim() : "";
  if (!deviceName || deviceName.length > 100) {
    return NextResponse.json(
      { error: "デバイス名を指定してください（100文字以内）", code: "invalid_request" },
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

    // ネイティブアプリの再ログイン: 同じデバイス名の古いトークンを先に失効させ、
    //   入れ直し・ログインし直しで枠（5 本）が埋まっていかないようにする。
    if (body?.replace_same_device === true) {
      await revokeTokensByDeviceName(email, deviceName);
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
    // 発行も監査対象（token_id は未発行なので null + endpoint で記録）。
    try {
      const { pool } = await import("@/lib/db");
      await pool.query(
        `INSERT INTO agent_audit_log (token_id, endpoint, status) VALUES (NULL, 'POST /api/agent/token', 201)`
      );
    } catch { /* best effort */ }
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
      { error: "トークン発行に失敗しました", code: "server_error" },
      { status: 500, headers: NO_CACHE }
    );
  }
}
