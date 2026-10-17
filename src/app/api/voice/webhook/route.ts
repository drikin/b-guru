/* POST /api/voice/webhook — LiveKit からの通知（入退室・部屋の終了）。
 * Authorization の JWT を API シークレットで検証し、本文の SHA-256 が一致した
 * ものだけ受け付ける。記録（voice_sessions / voice_participations）を更新して、
 * 部屋の状態を SSE で配信し直す。
 * LiveKit Cloud の設定: Webhook URL = https://bsm.backspace.fm/api/voice/webhook */
import { NextRequest, NextResponse } from "next/server";
import { livekitConfig, verifyWebhook } from "@/lib/livekit";
import { handleWebhookEvent, type LkWebhookEvent } from "@/lib/voice";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY = 64 * 1024;

export async function POST(req: NextRequest) {
  const cfg = livekitConfig();
  if (!cfg) return new NextResponse(null, { status: 404 });
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY) return new NextResponse(null, { status: 413 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new NextResponse(null, { status: 413 });
  if (!verifyWebhook(cfg, raw, req.headers.get("authorization"))) {
    return new NextResponse(null, { status: 401 });
  }
  let ev: LkWebhookEvent;
  try {
    ev = JSON.parse(raw);
  } catch {
    return new NextResponse(null, { status: 400 });
  }
  try {
    await handleWebhookEvent(ev);
  } catch (e) {
    console.error("[voice] webhook:", (e as Error)?.message);
    return new NextResponse(null, { status: 500 });
  }
  return new NextResponse(null, { status: 200 });
}
