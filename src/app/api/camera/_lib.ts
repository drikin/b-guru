/* /api/camera/* 共通（西田カメラ。lib/camera.ts）。 */
import { NextResponse } from "next/server";
import { CameraError } from "@/lib/camera";

export const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export function cameraErrorResponse(e: unknown): NextResponse {
  if (e instanceof CameraError) {
    return NextResponse.json({ error: e.code, message: e.message }, { status: e.status, headers: NO_CACHE });
  }
  console.error("[camera]", (e as Error)?.message);
  return NextResponse.json({ error: "server_error", message: "サーバーでエラーが起きました" }, { status: 500, headers: NO_CACHE });
}

export async function readJson(req: Request, max = 64 * 1024): Promise<unknown> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > max) throw new CameraError(413, "too_large", "大きすぎます");
  const text = await req.text();
  if (text.length > max) throw new CameraError(413, "too_large", "大きすぎます");
  try {
    return JSON.parse(text);
  } catch {
    throw new CameraError(400, "invalid_request", "JSON が必要です");
  }
}
