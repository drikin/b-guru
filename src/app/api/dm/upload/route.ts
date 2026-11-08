/* POST /api/dm/upload — ✉️👥 DM に付ける写真（Web・ログイン必須）。lib/dm-upload.ts。
 * 別サイトからのフォーム送信を断るためオリジンを確かめる。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { uploadDmPhotos } from "@/lib/dm-upload";
import { sameOrigin } from "../../auth/_lib";
import { guarded } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  return guarded(async () => {
    if (!sameOrigin(req)) return NextResponse.json({ error: "不正なリクエストです" }, { status: 403 });
    const email = await getSessionEmail();
    if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
    return uploadDmPhotos(req, email);
  });
}
