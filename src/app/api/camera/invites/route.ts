import { NextRequest, NextResponse } from "next/server";
import { isAdmin } from "@/lib/admin";
import { clientIp } from "@/lib/client-ip";
import {
  CameraError,
  addInvite,
  isValidEmail,
  listInvites,
  normalizeEmail,
  revokeInvite,
  verifyCameraToken,
} from "@/lib/camera";
import { NO_CACHE, cameraErrorResponse, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 招待（会員でない人を西田カメラに入れる）。管理者がアプリの設定から使う。 */
async function admin(req: NextRequest) {
  const user = await verifyCameraToken(req.headers.get("authorization"), clientIp(req));
  if (!isAdmin(user.email)) throw new CameraError(403, "forbidden", "管理者だけが使えます");
  return user;
}

export async function GET(req: NextRequest) {
  try {
    await admin(req);
    return NextResponse.json({ invites: await listInvites() }, { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await admin(req);
    const body = (await readJson(req)) as { email?: unknown; note?: unknown } | null;
    const email = normalizeEmail(body?.email);
    if (!isValidEmail(email)) throw new CameraError(400, "invalid_request", "メールアドレスが不正です");
    await addInvite(email, user.email, typeof body?.note === "string" ? body.note.trim() : "");
    return NextResponse.json({ invites: await listInvites() }, { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await admin(req);
    const email = normalizeEmail(req.nextUrl.searchParams.get("email"));
    if (!email) throw new CameraError(400, "invalid_request", "メールアドレスが必要です");
    await revokeInvite(email);
    return NextResponse.json({ invites: await listInvites() }, { headers: NO_CACHE });
  } catch (e) {
    return cameraErrorResponse(e);
  }
}
