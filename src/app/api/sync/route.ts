import { NextRequest, NextResponse } from "next/server";
import { syncNewEpisodes } from "@/lib/sync";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/sync — internal endpoint for the daily episode-sync cron.
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const secret = process.env.SYNC_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }

  try {
    const result = await syncNewEpisodes();
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("sync error:", e.message);
    return NextResponse.json({ error: "同期に失敗しました" }, { status: 500 });
  }
}
