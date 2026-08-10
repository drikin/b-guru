import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  deleteDrinews,
  getDrinews,
  isDrikin,
  listComments,
  publishDrinews,
  updateDrinews,
} from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function parseId(params: Promise<{ id: string }>): Promise<number | null> {
  const { id } = await params;
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// GET /api/drinews/[id] — article detail + comments (members)
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  const article = await getDrinews(id);
  if (!article) return NextResponse.json({ error: "記事が見つかりません" }, { status: 404 });
  // drafts only visible to drikin
  if (article.status !== "published" && !isDrikin(email)) {
    return NextResponse.json({ error: "まだ公開されていません" }, { status: 403 });
  }

  const comments = await listComments(id);
  return NextResponse.json({ article, comments });
}

// PATCH /api/drinews/[id] — edit a draft (drikin only)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "編集はドリキンのみ可能です" }, { status: 403 });

  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  let body: { title?: string; bodyMd?: string; bodyHtml?: string; headerImage?: string | null; scheduledAt?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  try {
    const article = await updateDrinews(id, {
      title: body.title ?? "",
      bodyMd: body.bodyMd ?? "",
      bodyHtml: body.bodyHtml ?? "",
      headerImage: body.headerImage !== undefined ? body.headerImage : null,
      scheduledAt: typeof body.scheduledAt === "string" ? body.scheduledAt : null,
    });
    return NextResponse.json({ article });
  } catch (e: any) {
    const status = e.message === "not_found_or_published" ? 404 : 500;
    return NextResponse.json(
      { error: e.message === "not_found_or_published" ? "下書きが見つからないか、既に公開済みです" : "保存失敗" },
      { status }
    );
  }
}

// POST /api/drinews/[id]/publish — publish immediately (drikin only)
// (Separate route file handles this; see [id]/publish/route.ts)
export async function POST() {
  return NextResponse.json({ error: "Not found" }, { status: 404 });
}

// DELETE /api/drinews/[id] — delete an article (drikin only). Comments cascade.
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  if (!isDrikin(email)) return NextResponse.json({ error: "削除はドリキンのみ可能です" }, { status: 403 });

  const id = await parseId(params);
  if (id === null) return NextResponse.json({ error: "不正なID" }, { status: 400 });

  try {
    await deleteDrinews(id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const status = e.message === "not_found" ? 404 : 500;
    return NextResponse.json(
      { error: e.message === "not_found" ? "記事が見つかりません" : "削除に失敗しました" },
      { status }
    );
  }
}
