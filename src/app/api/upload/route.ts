import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { handleUpload } from "@/lib/upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/upload — multipart form（中身は lib/upload.ts。アプリの /api/agent/upload と共通）
//   fields: images[] (up to 5)  → returns { urls }
//   fields: video (single)      → returns { videoUrl }
//   fields: audio (single)      → returns { audioUrl }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  return handleUpload(req, email);
}
