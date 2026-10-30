import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getMutedWordsApi, setMutedWordsApi } from "@/lib/muted-words";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

export const dynamic = "force-dynamic";

/** GET /api/muted-words — this user's NG words (drikin 2026-10-29). */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  try {
    const out = await getMutedWordsApi(email);
    return NextResponse.json(out.body, { status: out.status, headers: NO_CACHE });
  } catch (e) {
    console.error("muted-words GET error:", (e as Error).message);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** PUT /api/muted-words — { words: [...] } replaces the whole list. */
export async function PUT(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_CACHE });
  }
  try {
    const out = await setMutedWordsApi(email, body ?? {});
    return NextResponse.json(out.body, { status: out.status, headers: NO_CACHE });
  } catch (e) {
    console.error("muted-words PUT error:", (e as Error).message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
