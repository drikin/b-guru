import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { sakuraChat, ALLOWED_MODELS, type ChatTurn } from "@/lib/sakura";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// Simple in-process per-email rate limit (abuse protection).
// Map<email, { count, resetAt }> — window of 20 requests / 60s each.
const limit = new Map<string, { count: number; resetAt: number }>();
function rateLimit(email: string, limitPerWindow = 20, windowMs = 60_000): boolean {
  const now = Date.now();
  const cur = limit.get(email);
  if (!cur || now > cur.resetAt) {
    limit.set(email, { count: 1, resetAt: now + windowMs });
    return true;
  }
  cur.count += 1;
  return cur.count <= limitPerWindow;
}

const MAX_TURNS = 30;
const MAX_CONTENT = 8000; // chars per message

// POST /api/ai/chat — generic relay to さくらのAI Engine (login required).
// Body: { model?, messages: [{role,content}], temperature?, max_tokens? }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  if (!rateLimit(email)) {
    return NextResponse.json({ error: "リクエストが多すぎます。少し待ってから再試行してください" }, { status: 429, headers: NO_CACHE });
  }

  let body: { model?: unknown; messages?: unknown; temperature?: unknown; max_tokens?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400, headers: NO_CACHE });
  }

  if (!Array.isArray(body?.messages) || body.messages.length === 0) {
    return NextResponse.json({ error: "messages が不正です" }, { status: 400, headers: NO_CACHE });
  }

  const messages: ChatTurn[] = body.messages
    .slice(0, MAX_TURNS)
    .map((m: any) => ({
      role: (m?.role === "assistant" || m?.role === "system" ? m.role : "user") as ChatTurn["role"],
      content: typeof m?.content === "string" ? m.content.slice(0, MAX_CONTENT) : "",
    }))
    .filter((m) => m.content.length > 0);

  if (messages.length === 0) {
    return NextResponse.json({ error: "メッセージが空です" }, { status: 400, headers: NO_CACHE });
  }

  const model =
    typeof body.model === "string" && ALLOWED_MODELS.has(body.model) ? body.model : undefined;
  const temperature =
    typeof body.temperature === "number" && body.temperature >= 0 && body.temperature <= 2
      ? body.temperature
      : undefined;
  const max_tokens =
    typeof body.max_tokens === "number" && body.max_tokens >= 1 && body.max_tokens <= 8000
      ? body.max_tokens
      : undefined;

  try {
    const result = await sakuraChat({ model, messages, temperature, max_tokens });
    return NextResponse.json(
      { content: result.content, model: result.model, reasoning: result.reasoning },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("ai/chat:", e.message);
    return NextResponse.json(
      { error: e.message.includes("SAKURA_AI_API_KEY") ? "AIキーが設定されていません" : "AIリクエストに失敗しました" },
      { status: 500, headers: NO_CACHE }
    );
  }
}
