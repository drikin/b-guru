import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { revokeCameraToken, verifyCameraToken } from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** この端末の鍵を無効にする。 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyCameraToken(req.headers.get("authorization"), clientIp(req));
    await revokeCameraToken(user.tokenId);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
