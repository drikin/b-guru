import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { cameraProfile, normalizeEmail, verifyCameraLogin } from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 西田カメラのログイン 2: コードを確かめて鍵を返す（鍵の平文を返すのはこのときだけ）。 */
export async function POST(req: NextRequest) {
  try {
    const body = (await readJson(req)) as { email?: unknown; code?: unknown; device?: unknown } | null;
    const email = normalizeEmail(body?.email);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    const device = typeof body?.device === "string" ? body.device.trim() : "";
    const s = await verifyCameraLogin(email, code, device || "iPhone", clientIp(req));
    return NextResponse.json(
      { token: s.token, ...cameraProfile({ tokenId: 0, email: s.email, kind: s.kind }) },
      { headers: NO_CACHE }
    );
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
