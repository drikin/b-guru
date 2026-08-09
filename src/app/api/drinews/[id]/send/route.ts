import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getDrinews, isDrikin, sendDrinewsEmail } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/[id]/send — email a published article to all paid members (drikin only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "配信はドリキンのみ可能です" }, { status: 403 });

  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  const article = await getDrinews(n);
  if (!article) return NextResponse.json({ error: "記事が見つかりません" }, { status: 404 });
  if (article.status !== "published") {
    return NextResponse.json({ error: "公開済みの記事のみ配信できます" }, { status: 400 });
  }

  try {
    const result = await sendDrinewsEmail(article);
    return NextResponse.json(result);
  } catch (e: any) {
    console.error("drinews send:", e.message);
    return NextResponse.json({ error: `配信に失敗しました: ${e.message}` }, { status: 500 });
  }
}
