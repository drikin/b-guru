/* GET /api/voice — Web のボイスルーム: 使えるか（設定済み・試行中の許可リスト）と、
 * 今の部屋の状態（誰が入っているか）。ログインが必要。以降の変化は
 * /api/posts/stream の voice イベント（ログイン中の人にだけ流れる）で届く。 */
import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { emailToUserId } from "@/lib/user";
import { toAgentVoiceDto } from "@/lib/agent-chat";
import { getVoiceState, voiceEnabledFor } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  const enabled = voiceEnabledFor(email);
  if (!enabled) return NextResponse.json({ enabled: false }, { headers: NO_STORE });
  const [state, userId] = await Promise.all([getVoiceState(), emailToUserId(email)]);
  return NextResponse.json(
    { enabled: true, admin: isAdmin(email), userId, room: toAgentVoiceDto(state) },
    { headers: NO_STORE }
  );
}
