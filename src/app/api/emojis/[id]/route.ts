import { NextRequest, NextResponse } from "next/server";
import { deleteCustomEmoji } from "@/lib/reactions";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// DELETE /api/emojis/[id] — remove a custom emoji.
// Allowed for its creator, or an admin. Reactions referencing it are deleted
// with it (see deleteCustomEmoji) so no chip is left pointing at a dead image.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { id } = await params;
  const emojiId = Number(id);
  if (!Number.isInteger(emojiId) || emojiId <= 0) {
    return NextResponse.json({ error: "不正なID" }, { status: 400 });
  }

  try {
    await deleteCustomEmoji(emojiId, email, isAdmin(email));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    if (e.message === "not_found") {
      return NextResponse.json({ error: "絵文字が見つかりません" }, { status: 404 });
    }
    if (e.message === "forbidden") {
      return NextResponse.json(
        { error: "自分の登録した絵文字のみ削除できます" },
        { status: 403 }
      );
    }
    console.error("emoji delete error:", e.message);
    return NextResponse.json({ error: "絵文字の削除に失敗しました" }, { status: 500 });
  }
}
