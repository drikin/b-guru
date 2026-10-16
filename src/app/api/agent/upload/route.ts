/* POST /api/agent/upload — ネイティブアプリからの画像アップロード（スコープ post）。
 * Web の /api/upload と同じ lib/upload.ts（形式・サイズの検査、失敗時の後片付け）。画像だけ。
 *   multipart: images[]（最大 5 枚）→ { urls: ["/api/media/…"] } */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { handleUpload } from "@/lib/upload";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/upload", "post", async (ctx) => {
    const res = await handleUpload(req, ctx.email, { imagesOnly: true });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = { error: "アップロードに失敗しました" };
    }
    return { status: res.status, body, headers: {} };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
