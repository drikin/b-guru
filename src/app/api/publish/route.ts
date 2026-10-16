import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { publishPost, type PublishBody } from "@/lib/publish";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/publish  — body: { text: string, images?: string[] }
// 中身は lib/publish.ts（アプリの /api/agent/publish と共通）。
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  let body: PublishBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  const r = await publishPost(email, body);
  return NextResponse.json(r.body, { status: r.status });
}
