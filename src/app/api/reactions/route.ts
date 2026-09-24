import { NextRequest, NextResponse } from "next/server";
import { toggleReaction, getReactions, type ReactionTarget } from "@/lib/reactions";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TARGETS = new Set<ReactionTarget>(["post", "chat"]);

function parseTarget(v: string | null): ReactionTarget | null {
  return v && TARGETS.has(v as ReactionTarget) ? (v as ReactionTarget) : null;
}

// POST /api/reactions — toggle one emoji on one target.
//   body: { targetType: 'post'|'chat', targetId: number, emoji: string }
//   → { added: boolean, reactions: ReactionSummary[] }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエスト" }, { status: 400 });
  }

  const targetType = parseTarget(body?.targetType);
  const targetId = Number(body?.targetId);
  const emoji = typeof body?.emoji === "string" ? body.emoji : "";

  if (!targetType) {
    return NextResponse.json({ error: "不正な対象種別" }, { status: 400 });
  }
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return NextResponse.json({ error: "不正な対象ID" }, { status: 400 });
  }
  if (!emoji) {
    return NextResponse.json({ error: "絵文字が必要です" }, { status: 400 });
  }

  try {
    const result = await toggleReaction(targetType, targetId, email, emoji);
    return NextResponse.json(result);
  } catch (e: any) {
    if (e.message === "invalid_emoji") {
      return NextResponse.json({ error: "不正な絵文字です" }, { status: 400 });
    }
    if (e.message === "unknown_emoji") {
      return NextResponse.json({ error: "その絵文字は登録されていません" }, { status: 404 });
    }
    console.error("reaction error:", e.message);
    return NextResponse.json({ error: "リアクションの更新に失敗しました" }, { status: 500 });
  }
}

// GET /api/reactions?targetType=post&ids=1,2,3
//   → { reactions: { "1": ReactionSummary[], ... } }
// Batched so the feed can fetch every visible post's reactions in one request.
export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  const targetType = parseTarget(req.nextUrl.searchParams.get("targetType"));
  if (!targetType) {
    return NextResponse.json({ error: "不正な対象種別" }, { status: 400 });
  }

  const raw = req.nextUrl.searchParams.get("ids") ?? "";
  const ids = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 200); // cap: the feed never shows more than a few pages at once

  if (ids.length === 0) {
    return NextResponse.json({ reactions: {} });
  }

  try {
    const map = await getReactions(targetType, ids, email);
    const out: Record<string, unknown> = {};
    for (const [id, list] of map) out[String(id)] = list;
    return NextResponse.json({ reactions: out });
  } catch (e: any) {
    console.error("reactions fetch error:", e.message);
    return NextResponse.json({ error: "リアクションの取得に失敗しました" }, { status: 500 });
  }
}
