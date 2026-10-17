/* POST /api/agent/voice/token — ボイスルームの入室トークン（LiveKit JWT）。スコープ voice。
 *
 * 発行のたびに Ghost で有料会員かを確かめ直す（agent トークンの 6 時間ごとの
 * 再判定を待たない）。入室禁止（voice_bans）なら 403。トークンは 10 分・この部屋
 * だけ・マイクだけ・データ送信なし。identity は users.user_id（メールは渡さない）。 */
import { NextRequest } from "next/server";
import { AgentAuthError, withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { findMemberByEmail, isPaidMember } from "@/lib/ghost";
import { resolveDisplayName } from "@/lib/display-name";
import { livekitConfig } from "@/lib/livekit";
import {
  VOICE_ROOM,
  VOICE_TOKEN_TTL_SEC,
  ensureRoom,
  isVoiceBanned,
  issueJoinToken,
  voiceEnabledFor,
} from "@/lib/voice";
import { agentJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/voice/token", "voice", async (ctx) => {
    const cfg = livekitConfig();
    if (!cfg || !voiceEnabledFor(ctx.email)) {
      return { status: 404, body: { error: "ボイスルームは使えません", code: "not_found" }, headers: {} };
    }
    let member;
    try {
      member = await findMemberByEmail(ctx.email);
    } catch {
      // Ghost に届かないときは入れない（fail closed）。
      return { status: 503, body: { error: "会員確認ができません", code: "server_error", hint: "少し待ってから再試行してください" }, headers: {} };
    }
    if (!member || !isPaidMember(member)) {
      throw new AgentAuthError(403, {
        error: "BSM 会員資格が確認できません",
        code: "membership_ended",
        hint: "backspace.fm で会員状況をご確認ください",
      });
    }
    if (await isVoiceBanned(ctx.email)) {
      return { status: 403, body: { error: "ボイスルームに入れません", code: "forbidden" }, headers: {} };
    }
    await ensureRoom(cfg);
    const name = await resolveDisplayName(ctx.email);
    const token = issueJoinToken(cfg, ctx.userId, name);
    return {
      status: 200,
      body: {
        apiVersion: AGENT_API_VERSION,
        url: cfg.url,
        token,
        room: VOICE_ROOM,
        identity: ctx.userId,
        expires_in: VOICE_TOKEN_TTL_SEC,
      },
      headers: {},
    };
  });
  return agentJson(out);
}
