import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { editPoll, pollVoters } from "@/lib/post-actions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

// PUT /api/poll/[postId]  — body { question, options: {id|null,label}[] }
// お題（質問/選択肢）を編集できるのは post author のみ・投稿後1時間以内。
// 投票が1票でも付いた選択肢は削除不可（400）。
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_STORE });
  }
  const postId = Number((await params).postId);
  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }

  let body: { question?: unknown; options?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }

  // 検査と書き込みは lib/post-actions.ts（アプリ用 API と同じ）。
  const r = await editPoll(email, postId, body);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

// GET /api/poll/[postId] — 投票した人（選択肢ごと）。投稿者だけ（ほかは 403）。
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ postId: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_STORE });
  }
  const postId = Number((await params).postId);
  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }
  const r = await pollVoters(email, postId);
  return NextResponse.json(r.body, { status: r.status, headers: NO_STORE });
}

// POST（vote）は本ルートでは使わないが、Next.js は明示しない限りメソッド不在で 405。
export async function POST() {
  return NextResponse.json({ error: "Not Allowed" }, { status: 405, headers: NO_STORE });
}
