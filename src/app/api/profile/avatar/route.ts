import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  CUSTOM_AVATAR_MAX_BYTES,
  deleteCustomAvatar,
  emailMd5,
  hasCustomAvatar,
  saveCustomAvatar,
} from "@/lib/custom-avatar";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store" };

// 自分のアイコンだけ。上げ直しは 1 時間に 20 回まで（メモリ。pm2 は 1 プロセス）。
const recent = new Map<string, number[]>();
function rateOk(email: string): boolean {
  const now = Date.now();
  const list = (recent.get(email) || []).filter((t) => now - t < 3_600_000);
  if (list.length >= 20) return false;
  list.push(now);
  recent.set(email, list);
  return true;
}

// GET /api/profile/avatar — 自分のアイコンが上げたものか Gravatar か
export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  return NextResponse.json({ custom: hasCustomAvatar(emailMd5(email)) }, { headers: NO_CACHE });
}

// POST /api/profile/avatar — multipart の image（1 枚）。正方形の JPEG にして保存し { avatar } を返す。
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  if (!rateOk(email.toLowerCase()))
    return NextResponse.json({ error: "少し時間をおいてからもう一度どうぞ" }, { status: 429, headers: NO_CACHE });

  let file: File | null = null;
  try {
    const fd = await req.formData();
    const f = fd.get("image");
    if (f && typeof f !== "string") file = f;
  } catch {
    return NextResponse.json({ error: "画像を読めませんでした" }, { status: 400, headers: NO_CACHE });
  }
  if (!file) return NextResponse.json({ error: "画像が選択されていません" }, { status: 400, headers: NO_CACHE });
  if (file.size > CUSTOM_AVATAR_MAX_BYTES)
    return NextResponse.json({ error: "画像が大きすぎます（10MB まで）" }, { status: 413, headers: NO_CACHE });

  try {
    const avatar = await saveCustomAvatar(email, Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ avatar, custom: true }, { headers: NO_CACHE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "アイコンを保存できませんでした";
    return NextResponse.json({ error: msg }, { status: 400, headers: NO_CACHE });
  }
}

// DELETE /api/profile/avatar — 上げたアイコンを消して Gravatar に戻す
export async function DELETE() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  const avatar = await deleteCustomAvatar(email);
  return NextResponse.json({ avatar, custom: false }, { headers: NO_CACHE });
}
