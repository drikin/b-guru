/* GET /api/download/android/info — 配布中の Android アプリの版（会員のみ。セッションか agent token）。
 * Web の案内カードと、アプリ自身の更新確認（versionCode を比べる）が使う。配布が無ければ { available: false }。 */
import { NextResponse } from "next/server";
import { downloadAuthEmail } from "@/lib/download-auth";
import { getAndroidRelease } from "@/lib/app-downloads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const email = await downloadAuthEmail(req);
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  const rel = await getAndroidRelease();
  if (!rel) return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  return NextResponse.json(
    {
      available: true,
      version: rel.version,
      version_code: rel.versionCode,
      size: rel.size,
      sha256: rel.sha256,
      cert_sha256: rel.certSha256,
      min_sdk: rel.minSdk,
      notes: rel.notes,
      published_at: rel.publishedAt,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
