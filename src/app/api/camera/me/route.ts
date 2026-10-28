import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { cameraProfile, verifyCameraToken } from "@/lib/camera";
import { warmRelay } from "@/lib/camera-relay";
import { NO_CACHE, cameraErrorResponse } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 鍵が使えるかと、その人にできること（自由文・招待）。アプリの「つながっているか」の確認にも使う。
 *  アプリはカメラを開いたときに呼ぶので、ついでに dk5090 への接続を作っておく（撮って送るときに 0.4 秒縮む）。 */
export async function GET(req: NextRequest) {
  try {
    const user = await verifyCameraToken(req.headers.get("authorization"), clientIp(req));
    warmRelay(process.env.PROMPTCAM_RELAY_URL);
    return NextResponse.json(cameraProfile(user), { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
