/* POST / DELETE /api/user/[id]/mute — この人をタイムラインでミュートする・外す（本人の設定、drikin 2026-11-25）。
 * [id] は公開の user_id。相手には知らせない。lib/muted-words.ts。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { setUserMutedApi } from "@/lib/muted-words";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };
type Ctx = { params: Promise<{ id: string }> };

async function handle(muted: boolean, { params }: Ctx) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  try {
    const out = await setUserMutedApi(email, (await params).id, muted);
    return NextResponse.json(out.body, { status: out.status, headers: NO_CACHE });
  } catch (e) {
    console.error("user mute error:", (e as Error).message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

export async function POST(_req: NextRequest, ctx: Ctx) {
  return handle(true, ctx);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  return handle(false, ctx);
}
