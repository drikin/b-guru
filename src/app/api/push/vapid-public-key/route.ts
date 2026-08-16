import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getVapidPublicKey } from "@/lib/push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/push/vapid-public-key — the public VAPID key used to subscribe.
export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const publicKey = getVapidPublicKey();
  if (!publicKey) {
    return NextResponse.json({ error: "Push が未設定です" }, { status: 503 });
  }
  return NextResponse.json(
    { publicKey },
    { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } }
  );
}
