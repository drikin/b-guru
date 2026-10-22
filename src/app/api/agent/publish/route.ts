/* POST /api/agent/publish — ネイティブアプリからの投稿・返信（スコープ post）。
 * Web の /api/publish と同じ lib/publish.ts を通すので、返信・@メンション通知、部活の自動分類、
 * Live 配信、Web Push、重複防止まで Web から投稿したときと同じになる（via は付けない＝人の投稿）。
 *   body: { text, images?: ["/api/media/…"], parent_id?, whisper?, video_url?, audio_url?,
 *           poll?: { question, options: string[], duration_hours? }, club? }
 * 画像・動画・音声は /api/agent/upload で上げたものだけ（外部 URL は 400）。検査はすべて lib/publish.ts
 * （Web と同じ: 添付は動画・音声のどちらか 1 つ、画像 5 枚まで、投票は lib/poll.ts、部活はルート投稿だけ）。 */
import { NextRequest } from "next/server";
import { isAppToken, withAgent } from "@/lib/agent-auth";
import { publishPost } from "@/lib/publish";
import { NO_CACHE } from "../_lib";
import { agentPostDto } from "@/lib/agent-post-dto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** アプリの投票の形（snake_case）を Web の形へ。検査は lib/publish.ts → lib/poll.ts。 */
function agentPollInput(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw !== "object") return raw;
  const p = raw as { question?: unknown; options?: unknown; duration_hours?: unknown };
  return { question: p.question, options: p.options, durationHours: p.duration_hours ?? 24 };
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/publish", "post", async (ctx) => {
    let b: {
      text?: unknown;
      images?: unknown;
      parent_id?: unknown;
      whisper?: unknown;
      video_url?: unknown;
      audio_url?: unknown;
      poll?: unknown;
      club?: unknown;
    };
    try {
      b = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    // 段階 3 で足した添付（投票・動画・音声）と部活の手動選択はアプリの鍵だけ（外部の鍵は今までどおり
    // 本文・画像・返信・うなるまで。docs/timeline-spec.md §10.1）。
    const appOnly = [b.poll != null && "poll", b.video_url != null && "video_url", b.audio_url != null && "audio_url", b.club != null && "club"].filter(Boolean);
    if (appOnly.length && !isAppToken(ctx)) {
      return {
        status: 403,
        body: { error: `${appOnly.join("・")} はアプリ（B-guru のアプリでログインした鍵）からだけ使えます`, code: "forbidden" },
        headers: {},
      };
    }
    if (b.whisper === true && typeof b.parent_id !== "number") {
      return { status: 400, body: { error: "うなるは返信だけです", code: "invalid_request" }, headers: {} };
    }
    const r = await publishPost(
      ctx.email,
      {
        text: typeof b.text === "string" ? b.text : "",
        images: Array.isArray(b.images) ? b.images : [],
        parentId: typeof b.parent_id === "number" ? b.parent_id : null,
        // うなる（スレッドを上げない返信・通知を出さない）。返信のときだけ意味がある（Web と同じ）。
        whisper: b.whisper === true,
        videoUrl: b.video_url,
        audioUrl: b.audio_url,
        poll: agentPollInput(b.poll),
        club: b.club,
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
