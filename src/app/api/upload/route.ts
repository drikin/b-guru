import { NextRequest, NextResponse } from "next/server";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import crypto from "crypto";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGES = 5;
const MAX_BYTES = 10 * 1024 * 1024; // 10MB per image
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const MAX_VIDEO_BYTES = 20 * 1024 * 1024; // 20MB per video (server capacity)
const ALLOWED_VIDEO = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime", // .mov
]);

// POST /api/upload — multipart form
//   fields: images[] (up to 5)  → returns { urls }
//   fields: video (single)      → returns { videoUrl }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  let form;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const toFile = (f: FormDataEntryValue | null): File | null =>
    f && typeof f === "object" && "arrayBuffer" in f ? (f as File) : null;

  const videoFile = toFile(form.get("video"));

  // If a video field is present, treat this as a single-video upload.
  if (videoFile) {
    if (!ALLOWED_VIDEO.has(videoFile.type)) {
      return NextResponse.json(
        { error: `非対応の動画形式です: ${videoFile.type}` },
        { status: 400 }
      );
    }
    if (videoFile.size > MAX_VIDEO_BYTES) {
      return NextResponse.json(
        { error: "動画は20MBまでです" },
        { status: 400 }
      );
    }

    const uploadDir = path.join(process.cwd(), "public", "uploads");
    await mkdir(uploadDir, { recursive: true });

    const ext = path.extname(videoFile.name) || ".mp4";
    const safeExt = [".mp4", ".webm", ".mov"].includes(ext) ? ext : ".mp4";
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`;
    const buf = Buffer.from(await videoFile.arrayBuffer());
    await writeFile(path.join(uploadDir, filename), buf);

    return NextResponse.json(
      { videoUrl: `/api/media/${filename}` },
      { status: 201 }
    );
  }

  const files = form.getAll("images").filter(
    (f): f is File => typeof f === "object" && "arrayBuffer" in f
  );

  if (files.length === 0) {
    return NextResponse.json({ error: "画像が選択されていません" }, { status: 400 });
  }
  if (files.length > MAX_IMAGES) {
    return NextResponse.json({ error: `画像は最大${MAX_IMAGES}枚までです` }, { status: 400 });
  }

  const urls: string[] = [];
  for (const file of files) {
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json(
        { error: `非対応の画像形式です: ${file.type}` },
        { status: 400 }
      );
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { error: "画像は1枚あたり10MBまでです" },
        { status: 400 }
      );
    }
  }

  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadDir, { recursive: true });

  for (const file of files) {
    const ext = path.extname(file.name) || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`;
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(path.join(uploadDir, filename), buf);
    urls.push(`/api/media/${filename}`);
  }

  return NextResponse.json({ urls }, { status: 201 });
}
