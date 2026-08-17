import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getTrendKeywords } from "@/lib/trends";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// GET /api/trends — saved trend keywords (DB, no AI call per request). Login required.
export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  try {
    const keywords = await getTrendKeywords();
    return NextResponse.json({ keywords }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("trends:", e.message);
    // 一時エラーでもUIを壊さないよう空リストを返す
    return NextResponse.json({ keywords: [] }, { status: 200, headers: NO_CACHE });
  }
}
