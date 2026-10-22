/* POST /api/agent/upload — ネイティブアプリからのアップロード（スコープ post）。
 * Web の /api/upload と同じ lib/upload.ts（形式・サイズの検査、失敗時の後片付け）。
 *   multipart: images[]（最大 5 枚・合計 50MB）→ { urls: ["/api/media/…"] }
 *   multipart: video（mp4 / webm / mov・100MB まで）→ { video_url }
 *   multipart: audio（mp3 / m4a / aac / wav / ogg / opus / webm / flac・100MB まで）→ { audio_url }
 * 1 回に 1 種類（音声 → 動画 → 画像の順に見て、最初にあったものだけ。Web と同じ）。
 * 動画・音声はアプリのログインで発行した鍵（app_issued）だけ。外部の鍵は今までどおり画像だけ。 */
import { NextRequest } from "next/server";
import { isAppToken, withAgent } from "@/lib/agent-auth";
import { handleUpload } from "@/lib/upload";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/upload", "post", async (ctx) => {
    // 動画・音声はアプリの鍵だけ（§10.1）。外部の鍵は今までどおり画像だけ（imagesOnly：動画・音声は 400）。
    const res = await handleUpload(req, ctx.email, isAppToken(ctx) ? { appMedia: true } : { imagesOnly: true });
    let body: Record<string, unknown> = {};
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = { error: "アップロードに失敗しました" };
    }
    // Web の形（videoUrl / audioUrl）をアプリ用 API の形（snake_case）へ。画像は今までどおり urls。
    if (typeof body.videoUrl === "string") body = { video_url: body.videoUrl };
    else if (typeof body.audioUrl === "string") body = { audio_url: body.audioUrl };
    else if (res.status >= 400) body = { ...body, code: uploadErrorCode(res.status, String(body.error ?? "")) };
    // Retry-After（混み合いの 503）などはそのまま渡す。
    const headers: Record<string, string> = {};
    const retry = res.headers.get("Retry-After");
    if (retry) headers["Retry-After"] = retry;
    return { status: res.status, body, headers };
  });
  return agentJson(out);
}

/** アップロードの失敗の種類（アプリが出し分けに使う）。文言（error）は Web と同じ。
 *  busy=混み合い（503・Retry-After 秒後に送り直す） / too_large=大きすぎる / unsupported=形式が非対応・画像だけの経路に
 *  動画や音声 / invalid_request=そのほか。 */
function uploadErrorCode(status: number, error: string): string {
  if (status === 503) return "busy";
  if (status === 413 || /MBまで|大きすぎ/.test(error)) return "too_large";
  if (/非対応|画像だけ送れます/.test(error)) return "unsupported";
  return status >= 500 ? "server_error" : "invalid_request";
}
