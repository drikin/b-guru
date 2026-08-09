import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isDrikin, scheduleDrinews } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/drinews/[id]/schedule — set scheduled publish time (drikin only)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "ドリキンのみ可能です" }, { status: 403 });

  const { id } = await params;
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  let body: { scheduledAt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }
  if (!body.scheduledAt) return NextResponse.json({ error: "予定時刻が必要です" }, { status: 400 });

  try {
    const article = await scheduleDrinews(n, body.scheduledAt);
    return NextResponse.json({ article });
  } catch (e: any) {
    const status = e.message === "not_found_or_published" ? 404 : 500;
    return NextResponse.json(
      { error: e.message === "not_found_or_published" ? "下書きが見つからないか、既に公開済みです" : "スケジュール設定に失敗しました" },
      { status }
    );
  }
}
