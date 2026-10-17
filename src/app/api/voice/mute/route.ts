/* POST /api/voice/mute — Web から参加者のマイクを切る（管理者だけ）。{ user_id }
 * 中身は lib/voice-actions.ts（アプリと共通）。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { emailToUserId } from "@/lib/user";
import { muteInVoice, webVoiceRateOk } from "@/lib/voice-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  if (!webVoiceRateOk(`mute:${email}`)) {
    return NextResponse.json({ error: "少し待ってから試してください", code: "rate_limited" }, { status: 429, headers: NO_STORE });
  }
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_STORE });
  }
  try {
    const r = await muteInVoice(email, await emailToUserId(email), input);
    return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (e) {
    console.error("[voice] web mute:", (e as Error)?.message);
    return NextResponse.json({ error: "操作できませんでした" }, { status: 500, headers: NO_STORE });
  }
}
