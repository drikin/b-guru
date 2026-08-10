import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  createDrinews,
  isDrikin,
  listAllDrinews,
  listPublishedDrinews,
} from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/drinews — list articles.
// Members (paid) see published; drikin sees all including drafts.
export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  try {
    const all = req.nextUrl.searchParams.get("all") === "1";
    const articles = all && isDrikin(email) ? await listAllDrinews() : await listPublishedDrinews();
    return NextResponse.json({ articles, isDrikin: isDrikin(email) });
  } catch (e: any) {
    console.error("drinews GET:", e.message);
    return NextResponse.json({ error: "取得失敗" }, { status: 500 });
  }
}

// POST /api/drinews — create a new draft (drikin only)
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) {
    return NextResponse.json({ error: "ドリニュースの投稿はドリキンのみ可能です" }, { status: 403 });
  }

  let body: { title?: string; bodyMd?: string; bodyHtml?: string; headerImage?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  try {
    const article = await createDrinews({
      authorEmail: email,
      title: body.title ?? "",
      bodyMd: body.bodyMd ?? "",
      bodyHtml: body.bodyHtml ?? "",
      headerImage: body.headerImage ?? null,
    });
    return NextResponse.json({ article }, { status: 201 });
  } catch (e: any) {
    console.error("drinews POST:", e.message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}
