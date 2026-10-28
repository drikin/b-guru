import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { cameraJobStatus, verifyCameraToken } from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 自分の加工がいまどこか（送信中・GPU 待ち・順番待ち・加工中・受信中、前に何人、あと何秒）。アプリが加工中に聞く。 */
export async function GET(req: NextRequest) {
  try {
    const user = await verifyCameraToken(req.headers.get("authorization"), clientIp(req), false);
    const job = req.nextUrl.searchParams.get("job") ?? "";
    return NextResponse.json(await cameraJobStatus(user, job), { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
