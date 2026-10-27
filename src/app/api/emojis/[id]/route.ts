import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { EmojiError, removeCustomEmoji } from "@/lib/custom-emoji";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DELETE /api/emojis/[id] — remove a custom emoji. Any logged-in member (owner 2026-10-27
// 「誰でもどこからでも絵文字を登録削除」; who deleted it is logged). Reactions referencing it are
// deleted with it (see deleteCustomEmoji) so no chip is left pointing at a dead image.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { id } = await params;
  try {
    await removeCustomEmoji(email, id);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e instanceof EmojiError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("emoji delete error:", e.message);
    return NextResponse.json({ error: "絵文字の削除に失敗しました" }, { status: 500 });
  }
}
