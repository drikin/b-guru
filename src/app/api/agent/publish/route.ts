/* POST /api/agent/publish — ネイティブアプリからの投稿・返信（スコープ post）。
 * Web の /api/publish と同じ lib/publish.ts を通すので、返信・@メンション通知、部活の自動分類、
 * Live 配信、Web Push、重複防止まで Web から投稿したときと同じになる（via は付けない＝人の投稿）。
 *   body: { text, images?: ["/api/media/…"], parent_id? }
 * 画像は /api/agent/upload で上げたものだけ（外部 URL は 400）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { publishPost } from "@/lib/publish";
import { NO_CACHE } from "../_lib";
import { agentPostDto } from "@/lib/agent-post-dto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/publish", "post", async (ctx) => {
    let b: { text?: unknown; images?: unknown; parent_id?: unknown };
    try {
      b = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const r = await publishPost(
      ctx.email,
      {
        text: typeof b.text === "string" ? b.text : "",
        images: Array.isArray(b.images) ? b.images : [],
        parentId: typeof b.parent_id === "number" ? b.parent_id : null,
      },
      { localImagesOnly: true }
    );
    const body = r.body as { post?: Parameters<typeof agentPostDto>[0]; error?: string };
    if (r.status === 201 && body.post) {
      return { status: 201, body: { apiVersion: 1, post: agentPostDto(body.post) }, headers: {} };
    }
    return { status: r.status, body: { error: body.error ?? "投稿に失敗しました", code: r.status >= 500 ? "server_error" : "invalid_request" }, headers: {} };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
