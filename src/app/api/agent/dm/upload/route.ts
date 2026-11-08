/* POST /api/agent/dm/upload — ✉️👥 DM に付ける写真（スコープ chat）。
 *   multipart: images[]（最大 4 枚・1 枚 4MB まで。アプリが長辺 1280px に縮めて送る）
 *   → { urls: ["/api/media/dm-…"] }。送信（/api/agent/dm/:userId・グループの messages）の images に入れる。
 *   見られるのは当事者だけ、DM と一緒に 30 日で消える（lib/dm-media.ts）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { uploadDmPhotos } from "@/lib/dm-upload";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/dm/upload", "chat", async (ctx) => {
    const res = await uploadDmPhotos(req, ctx.email);
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
