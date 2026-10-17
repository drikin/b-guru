/* POST /api/voice/token — Web のボイスルーム入室トークン。ログイン（セッション Cookie）が必要。
 * 中身は lib/voice-actions.ts（アプリの /api/agent/voice/token と共通）。 */
import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { issueVoiceJoin, webVoiceRateOk } from "@/lib/voice-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  if (!webVoiceRateOk(email)) {
    return NextResponse.json({ error: "少し待ってから試してください", code: "rate_limited" }, { status: 429, headers: NO_STORE });
  }
  try {
    const r = await issueVoiceJoin(email, await ensureUserId(email));
    return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (e) {
    console.error("[voice] web token:", (e as Error)?.message);
    return NextResponse.json({ error: "ボイスルームにつながりませんでした" }, { status: 500, headers: NO_STORE });
  }
}
