import { NextRequest, NextResponse } from "next/server";
import { generateTrendKeywords } from "@/lib/trends";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/trends/refresh — force a trend-keyword regeneration.
// Called by an external cron every 6h (drinews process-scheduled pattern).
// Same shared-secret guard as /api/drinews/process-scheduled.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.DRINEWS_SCHEDULE_SECRET || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await generateTrendKeywords();
    return NextResponse.json({ keywords: result, count: result.length });
  } catch (e: any) {
    console.error("trends/refresh:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
