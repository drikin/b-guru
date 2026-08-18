import { NextRequest, NextResponse } from "next/server";
import { runBeagleTick } from "@/lib/beagle";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/beagle/tick — ビーグルエージェントを1回実行（外部 cron が叩く）。
// 共有シークレット（BEAGLE_SCHEDULE_SECRET / DRINEWS_SCHEDULE_SECRET 互換）で守る。
// ?dry=1 で投稿しない（決定のみ記録）。
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret =
    process.env.BEAGLE_SCHEDULE_SECRET || process.env.DRINEWS_SCHEDULE_SECRET || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const qDry = req.nextUrl.searchParams.get("dry"); // '1' | '0' | null
  const defaultLive = (process.env.BEAGLE_MODE || "dry") === "live";
  const dry = qDry !== null ? qDry === "1" : !defaultLive;

  try {
    const result = await runBeagleTick({ dry });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("beagle/tick:", e?.message);
    return NextResponse.json({ error: e?.message || "beagle tick failed" }, { status: 500 });
  }
}
