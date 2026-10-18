/* POST /api/agent/chat/upload — チャットに付ける写真（スコープ chat）。
 *   multipart: images[]（最大 4 枚・1 枚 4MB まで。アプリが長辺 1280px に縮めて送る）
 *   → { urls: ["/api/media/chat-…"] }。チャットと一緒に 24 時間で消える。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { handleUpload } from "@/lib/upload";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat/upload", "chat", async (ctx) => {
    const res = await handleUpload(req, ctx.email, { chat: true });
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
