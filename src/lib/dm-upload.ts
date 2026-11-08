/* ✉️👥 DM の写真を上げる（Web の /api/dm/upload とアプリの /api/agent/dm/upload で共通）。
 * 保存したら public の外（data/dm-media）へ移す（lib/dm-media.ts）。
 * チャットの写真と同じ形（multipart images[]、最大 4 枚・1 枚 4MB）→ { urls: ["/api/media/dm-…"] }。
 * 上げた人を dm_uploads に残す（送るときに自分の写真か確かめる。lib/dm-media.ts）。 */
import { NextResponse } from "next/server";
import { handleUpload } from "./upload";
import { dmEnabledFor } from "./dm";
import { gdmEnabledFor } from "./gdm";
import { recordDmUploads } from "./dm-media";

export async function uploadDmPhotos(req: Request, email: string): Promise<NextResponse> {
  if (!dmEnabledFor(email) && !gdmEnabledFor(email)) {
    return NextResponse.json({ error: "DM はまだ使えません", code: "not_found" }, { status: 404 });
  }
  return handleUpload(req, email, { dm: true, onSaved: (urls) => recordDmUploads(email, urls) });
}
