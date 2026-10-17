/* /api/voice/bans — 管理者: ボイスルームの入室禁止の一覧（GET）と解除（DELETE { user_id }）。
 * 中身は lib/voice-actions.ts。解除は voice_mod_log に unban として残る。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { listVoiceBans, unbanVoice } from "@/lib/voice-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  const r = await listVoiceBans(email);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function DELETE(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_STORE });
  }
  const r = await unbanVoice(email, input);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
