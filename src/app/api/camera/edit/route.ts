import { NextRequest } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { CAMERA_MAX_BODY, parseEditBody, runCameraEdit, verifyCameraToken } from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

/** 写真を加工する: 鍵を確かめ、写真を描き直して dk5090 に頼み、JPEG を返す。写真も結果も保存しない。 */
export async function POST(req: NextRequest) {
  try {
    const user = await verifyCameraToken(req.headers.get("authorization"), clientIp(req));
    const edit = parseEditBody(await readJson(req, CAMERA_MAX_BODY));
    const r = await runCameraEdit(user, edit);
    return new Response(new Uint8Array(r.jpeg), {
      headers: { "Content-Type": "image/jpeg", "X-Seed": r.seed, "X-Elapsed": r.elapsed, ...NO_CACHE },
    });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
