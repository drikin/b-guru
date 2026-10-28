import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { CameraError, isValidEmail, normalizeEmail, requestCameraLogin } from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 西田カメラのログイン 1: コードをメールで送る。使えない人にも同じ返事（誰が使えるかを調べられないように）。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await readJson(req)) as { email?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!isValidEmail(email)) throw new CameraError(400, "invalid_request", "メールアドレスが不正です");
    await requestCameraLogin(email, clientIp(req));
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
