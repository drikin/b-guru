import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isDrikin, unpublishDrinews } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/[id]/unpublish — revert a published article back to draft (drikin only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "ドリキンのみ可能です" }, { status: 403 });

  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  try {
    const article = await unpublishDrinews(n);
    return NextResponse.json({ article });
  } catch (e: any) {
    const status = e.message === "not_found_or_not_published" ? 404 : 500;
    return NextResponse.json(
      { error: e.message === "not_found_or_not_published" ? "公開済みの記事が見つかりません" : "下書きへの変更に失敗しました" },
      { status }
    );
  }
}
