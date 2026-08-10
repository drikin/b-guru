import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getSessionEmail } from "@/lib/session";
import { isDrikin } from "@/lib/drinews";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// POST /api/drinews/upload — upload a header image (drikin only)
// Returns { url: "/api/drinews/image/<filename>" }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }
  if (!isDrikin(email)) {
    return NextResponse.json({ error: "画像アップロードはドリキンのみ可能です" }, { status: 403 });
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const file = form.get("image");
  if (!file || typeof file === "string" || !("arrayBuffer" in file)) {
    return NextResponse.json({ error: "画像が選択されていません" }, { status: 400 });
  }

  const f = file as File;
  if (!ALLOWED.has(f.type)) {
    return NextResponse.json({ error: `非対応の画像形式です: ${f.type}` }, { status: 400 });
  }
  if (f.size > MAX_BYTES) {
    return NextResponse.json({ error: "画像は10MBまでです" }, { status: 400 });
  }

  const uploadDir = path.join(process.cwd(), "public", "uploads", "drinews");
  await mkdir(uploadDir, { recursive: true });

  const ext = path.extname(f.name) || ".jpg";
  const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
  const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`;
  const buf = Buffer.from(await f.arrayBuffer());
  await writeFile(path.join(uploadDir, filename), buf);

  return NextResponse.json({ url: `/api/drinews/image/${filename}` }, { status: 201 });
}
