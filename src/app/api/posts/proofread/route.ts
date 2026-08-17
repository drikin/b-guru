import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { proofreadPost } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// Simple in-process per-email rate limit (abuse protection for AI costs).
// Map<email, { count, resetAt }> — window of 10 requests / 60s each.
const limit = new Map<string, { count: number; resetAt: number }>();
function rateLimit(email: string, limitPerWindow = 10, windowMs = 60_000): boolean {
  const now = Date.now();
  const cur = limit.get(email);
  if (!cur || now > cur.resetAt) {
    limit.set(email, { count: 1, resetAt: now + windowMs });
    return true;
  }
  cur.count += 1;
  return cur.count <= limitPerWindow;
}

const MIN_LEN = 500; // "AI校正" button enables >500 chars (checked on the client)
const MAX_LEN = 20000; // cap input length

// POST /api/posts/proofread — AI-proofread a long timeline post (login required).
// Body: { bodyMd }. Returns { markdown }. Parent posts only; handled by client.
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  if (!rateLimit(email)) {
    return NextResponse.json({ error: "リクエストが多すぎます。少し待ってから再試行してください" }, { status: 429, headers: NO_CACHE });
  }

  let body: { bodyMd?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400, headers: NO_CACHE });
  }

  const bodyMd = typeof body?.bodyMd === "string" ? body.bodyMd.trim() : "";
  if (bodyMd.length <= MIN_LEN) {
    return NextResponse.json({ error: "AI校正は500文字以上の投稿で利用できます" }, { status: 400, headers: NO_CACHE });
  }
  const slim = bodyMd.slice(0, MAX_LEN);

  try {
    const markdown = await proofreadPost(slim);
    return NextResponse.json({ markdown }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("posts/proofread:", e.message);
    return NextResponse.json(
      { error: e.message.includes("SAKURA_AI_API_KEY") ? "AIキーが設定されていません" : "AI校正に失敗しました" },
      { status: 500, headers: NO_CACHE }
    );
  }
}
