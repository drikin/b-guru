import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { handleUpload } from "@/lib/upload";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/chat/upload — photos for a chat message (multipart images[], at most 4,
// each ≤ 4 MB; the browser resizes to a 1280 px long side first) → { urls }.
// Saved as chat-… and deleted with the chat after 24 h (lib/chat.ts).
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  return handleUpload(req, email, { chat: true });
}
