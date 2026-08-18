import { NextRequest, NextResponse } from "next/server";
import { runBeagleTick } from "@/lib/beagle";
import { getState } from "@/lib/beagle/store";
import { countNewMentions } from "@/lib/beagle/observe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/beagle/check — 軽量な目覚まし。次回予約時刻を過ぎている OR 新規メンションが
// ある場合に tick を実行（メンションには予約より早く反応）。それ以外は {due:false}。
// スケジューラ（数分ポーラ）はこれを叩くだけでよい。
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
    const newMentions = await countNewMentions(state.lastTickAt);
    if (!due && newMentions === 0) {
      return NextResponse.json({ due: false, nextActivityAt: state.nextActivityAt });
    }
    const trigger = newMentions > 0 ? "mention" : "due";
    const result = await runBeagleTick({ dry });
    return NextResponse.json({ due: true, trigger, ...result });
  } catch (e: any) {
    console.error("beagle/check:", e?.message);
    return NextResponse.json({ error: e?.message || "beagle check failed" }, { status: 500 });
  }
}
