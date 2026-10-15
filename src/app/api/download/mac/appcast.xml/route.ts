/* GET /api/download/mac/appcast.xml — Sparkle の更新情報（会員 or アプリのトークン）。
 * 版・ビルド番号・EdDSA 署名は mac.json から（native/mac/scripts/publish.sh が書く）。 */
import { NextResponse } from "next/server";
import { downloadAuthEmail } from "@/lib/download-auth";
import { buildAppcast, getMacRelease } from "@/lib/app-downloads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const email = await downloadAuthEmail(req);
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const rel = await getMacRelease();
  return new Response(buildAppcast(rel, "https://bsm.backspace.fm"), {
    status: 200,
    headers: { "Content-Type": "application/rss+xml; charset=utf-8", "Cache-Control": "private, no-store" },
  });
}
