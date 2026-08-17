import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isDrikin } from "@/lib/drinews";
import { proofreadDrinews } from "@/lib/ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/proofread — AI-proofread / restructure a draft (drikin only)
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "校正はドリキンのみ可能です" }, { status: 403 });

  let body: { title?: string; bodyMd?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  const bodyMd = (body.bodyMd ?? "").slice(0, 20000); // cap input length
  try {
    const result = await proofreadDrinews({ title: body.title, bodyMd });
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("drinews proofread:", e.message);
    return NextResponse.json(
      { error: e.message.includes("SAKURA_AI_API_KEY") ? "AIキーが設定されていません" : "AI校正に失敗しました" },
      { status: 500 }
    );
  }
}
