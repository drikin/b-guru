/* GET /api/room — 部室のマップと、いる人（ログイン中のセッション）。
 * POST /api/room — { action: "enter" | "text" | "move" | "voice" | "react", … }。
 * 中身は lib/room-api.ts（アプリの /api/agent/room と共通）。変化は SSE の room イベントで届く。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { roomGet, roomPost } from "@/lib/room-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  const r = await roomGet(email, "web");
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  let body: Record<string, unknown> | null = null;
  try {
    body = await req.json();
  } catch {
    /* empty → 400 below */
  }
  const r = await roomPost(email, body, "web");
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}
