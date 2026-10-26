/* POST /api/voice/handoff — Web の「スマホで続ける」。{ target: "offkai"|"voice"|"room", mic }
 * → 本人のスマホへ知らせを 1 件（docs/device-sync-spec.md）。中身は lib/voice-handoff.ts（アプリと共通）。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { sameOrigin } from "@/app/api/auth/_lib";
import { requestVoiceHandoff } from "@/lib/voice-handoff";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function POST(req: NextRequest) {
  // ほかのサイトから本人のスマホへ知らせを出させない。
  if (!sameOrigin(req)) return NextResponse.json({ error: "不正なリクエストです" }, { status: 403, headers: NO_STORE });
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインしてください" }, { status: 401, headers: NO_STORE });
  let input: Record<string, unknown>;
  try {
    input = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_STORE });
  }
  try {
    const r = await requestVoiceHandoff(email, input);
    return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
  } catch (e) {
    console.error("[voice] web handoff:", (e as Error)?.message);
    return NextResponse.json({ error: "送れませんでした" }, { status: 500, headers: NO_STORE });
  }
}
