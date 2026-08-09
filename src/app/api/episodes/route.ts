import { NextResponse } from "next/server";
import { fetchBsmEpisodes } from "@/lib/bsm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const episodes = await fetchBsmEpisodes();
    return NextResponse.json({ episodes });
  } catch (e: any) {
    console.error("episodes error:", e.message);
    return NextResponse.json(
      { error: "エピソード一覧の取得に失敗しました" },
      { status: 502 }
    );
  }
}
