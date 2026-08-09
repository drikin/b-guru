import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isDrikin, publishDrinews } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/[id]/publish — publish immediately (drikin only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "公開はドリキンのみ可能です" }, { status: 403 });

  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  try {
    const article = await publishDrinews(n);
    return NextResponse.json({ article });
  } catch (e: any) {
    console.error("drinews publish:", e.message);
    return NextResponse.json({ error: "公開に失敗しました" }, { status: 500 });
  }
}
