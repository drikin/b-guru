import { NextRequest, NextResponse } from "next/server";
import { runBeagleTick } from "@/lib/beagle";
import { getState } from "@/lib/beagle/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/beagle/check — 軽量な目覚まし。beagle_state.next_activity_at が
// 現在時刻を過ぎていたら tick を実行、過ぎていなければ {due:false} を返す。
// スケジューラ（5分ポーラ等）はこれを叩くだけでよい。
export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") || "";
  const secret =
    process.env.BEAGLE_SCHEDULE_SECRET || process.env.DRINEWS_SCHEDULE_SECRET || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const qDry = req.nextUrl.searchParams.get("dry");
  const defaultLive = (process.env.BEAGLE_MODE || "dry") === "live";
  const dry = qDry !== null ? qDry === "1" : !defaultLive;

  try {
    const state = await getState();
    const now = Date.now();
    const due = !state.nextActivityAt || new Date(state.nextActivityAt).getTime() <= now;
    if (!due) {
      return NextResponse.json({ due: false, nextActivityAt: state.nextActivityAt });
    }
    const result = await runBeagleTick({ dry });
    return NextResponse.json({ due: true, ...result });
  } catch (e: any) {
    console.error("beagle/check:", e?.message);
    return NextResponse.json({ error: e?.message || "beagle check failed" }, { status: 500 });
  }
}
