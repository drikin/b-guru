/* GET /api/download/mac — B-guru Chat for Mac（ベータ）の DMG を配る。会員（ログイン中）のみ。
 * 本体はリポジトリ外（lib/app-downloads.ts の DOWNLOADS_DIR）に置き、manifest で版を切り替える。 */
import { NextResponse } from "next/server";
import { createReadStream } from "fs";
import { Readable } from "stream";
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
  if (!rel) {
    return NextResponse.json({ error: "配布中のバージョンがありません" }, { status: 404 });
  }
  const body = Readable.toWeb(createReadStream(/*turbopackIgnore: true*/ rel.path)) as ReadableStream;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-apple-diskimage",
      "Content-Length": String(rel.size),
      "Content-Disposition": `attachment; filename="${rel.file}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
