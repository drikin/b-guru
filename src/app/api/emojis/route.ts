import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { listCustomEmojis } from "@/lib/reactions";
import { EmojiError, registerCustomEmoji } from "@/lib/custom-emoji";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/emojis — every registered custom emoji.
export async function GET() {
  try {
    return NextResponse.json({ emojis: await listCustomEmojis() });
  } catch (e: any) {
    console.error("emoji list error:", e.message);
    return NextResponse.json({ error: "絵文字の取得に失敗しました" }, { status: 500 });
  }
}

// POST /api/emojis — register a custom emoji (multipart: name + image).
// Open to any logged-in member (drikin 2026-09-25: 「誰でも登録可」). The rules live in lib/custom-emoji.ts
// (the apps' /api/agent/emojis uses the same).
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "不正なリクエスト" }, { status: 400 });
  }

  try {
    const emoji = await registerCustomEmoji(email, form.get("name"), form.get("image"));
    return NextResponse.json({ emoji });
  } catch (e: any) {
    if (e instanceof EmojiError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.error("emoji create error:", e.message);
    return NextResponse.json({ error: "絵文字の登録に失敗しました" }, { status: 500 });
  }
}
