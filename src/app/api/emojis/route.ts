import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getSessionEmail } from "@/lib/session";
import { createCustomEmoji, listCustomEmojis } from "@/lib/reactions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Custom emoji images are small by nature — they render at ~20px in a chip.
// 256KB is generous for a PNG/GIF and keeps a single upload from filling the
// disk (the VPS runs at 82% and this endpoint is open to every member).
const MAX_BYTES = 256 * 1024;
const ALLOWED = new Set(["image/png", "image/gif", "image/webp", "image/jpeg"]);

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
// Open to any logged-in member (drikin 2026-09-25: 「誰でも登録可」).
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

  const name = String(form.get("name") ?? "").trim();
  const file = form.get("image");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "画像が必要です" }, { status: 400 });
  }
  if (!ALLOWED.has(file.type)) {
    return NextResponse.json(
      { error: "PNG / GIF / WebP / JPEG のみ登録できます" },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      { error: "画像は256KBまでです" },
      { status: 400 }
    );
  }

  try {
    const buf = Buffer.from(await file.arrayBuffer());
    const ext =
      file.type === "image/png"
        ? ".png"
        : file.type === "image/gif"
        ? ".gif"
        : file.type === "image/webp"
        ? ".webp"
        : ".jpg";
    const filename = `emoji-${crypto.randomBytes(8).toString("hex")}${ext}`;
    const dir = path.join(process.cwd(), "public", "uploads");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, filename), buf);

    // Served through /api/media so runtime-uploaded files do not hit the
    // `public/` build-manifest 404 problem (same reason as post images).
    const emoji = await createCustomEmoji(name, `/api/media/${filename}`, email);
    return NextResponse.json({ emoji });
  } catch (e: any) {
    if (e.message === "invalid_name") {
      return NextResponse.json(
        { error: "名前は英小文字・数字・_ のみ、32文字までです" },
        { status: 400 }
      );
    }
    if (e.message === "name_taken") {
      return NextResponse.json(
        { error: "その名前は既に使われています" },
        { status: 409 }
      );
    }
    console.error("emoji create error:", e.message);
    return NextResponse.json({ error: "絵文字の登録に失敗しました" }, { status: 500 });
  }
}
