import { NextRequest, NextResponse } from "next/server";
import { processScheduledDrinews } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/process-scheduled — publish + email any due drafts.
// Called by cron (e.g. every ~10 min, esp around 18:00 JST). Idempotent.
export async function POST(req: NextRequest) {
  // Simple shared-secret guard for cron
  const auth = req.headers.get("authorization") || "";
  const secret = process.env.DRINEWS_SCHEDULE_SECRET || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processScheduledDrinews();
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("drinews process-scheduled:", e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
