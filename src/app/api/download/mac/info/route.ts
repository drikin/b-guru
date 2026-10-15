/* GET /api/download/mac/info — 配布中の Mac アプリの版・サイズ・SHA-256（会員のみ）。
 * 右サイドバーのダウンロードカードが使う。配布が無ければ { available: false }。 */
import { NextResponse } from "next/server";
import { downloadAuthEmail } from "@/lib/download-auth";
import { getMacRelease } from "@/lib/app-downloads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const email = await downloadAuthEmail(req);
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const rel = await getMacRelease();
  if (!rel) return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    {
      available: true,
      version: rel.version,
      size: rel.size,
      sha256: rel.sha256,
      minimumSystemVersion: rel.minimumSystemVersion,
      publishedAt: rel.publishedAt,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
