import { NextRequest, NextResponse } from "next/server";
import { rm, mkdir } from "fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "path";
import crypto from "crypto";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_IMAGES = 5;
const MAX_BYTES = 100 * 1024 * 1024; // 100MB per image
const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

const MAX_VIDEO_BYTES = 100 * 1024 * 1024; // 100MB per video (server capacity)
const ALLOWED_VIDEO = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime", // .mov
]);

const MAX_AUDIO_BYTES = 100 * 1024 * 1024; // 100MB per audio
const ALLOWED_AUDIO = new Set([
  "audio/mpeg", // .mp3
  "audio/mp4", // .m4a
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/webm",
  "audio/flac",
  "audio/x-flac",
]);

// Extensions accepted for audio uploads (used when the browser sends no MIME type).
const AUDIO_EXTS = new Set([
  ".mp3",
  ".m4a",
  ".aac",
  ".wav",
  ".ogg",
  ".oga",
  ".opus",
  ".webm",
  ".flac",
]);

// POST /api/upload — multipart form
//   fields: images[] (up to 5)  → returns { urls }
//   fields: video (single)      → returns { videoUrl }
//   fields: audio (single)      → returns { audioUrl }
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
  const audioFile = toFile(form.get("audio"));

  const uploadDir = path.join(process.cwd(), "public", "uploads");
  await mkdir(uploadDir, { recursive: true });

  // Save one file, mapping a size-limit hit to a 400. Oversize files are
  // rejected from file.size BEFORE any bytes hit disk (defense against
  // repeated oversized uploads exhausting disk space). The stream-side LIMIT
  // guard is belt-and-braces in case size and actual bytes ever diverge.
  // Any other error rethrows (the caller cleans up already-written files).
  const saveOrReject = async (
    file: File,
    label: string,
    maxBytes: number,
    makeFilename: () => string
  ): Promise<NextResponse | null> => {
    if (file.size > maxBytes) {
      return NextResponse.json({ error: `${label}は100MBまでです` }, { status: 400 });
    }
    const filename = makeFilename();
    let written = 0;
    const limit = new Transform({
      transform(chunk, _enc, cb) {
        written += chunk.length;
        if (written > maxBytes) {
          cb(new Error(`LIMIT:${maxBytes}`));
          return;
        }
        cb(null, chunk);
      },
    });
    const src = Readable.fromWeb(file.stream() as Parameters<typeof Readable.fromWeb>[0]);
    try {
      await pipeline(src, limit, createWriteStream(path.join(uploadDir, filename)));
    } catch (err) {
      // A rejected upload must never leave a partial file on disk.
      await rm(path.join(uploadDir, filename), { force: true });
      if (err instanceof Error && err.message.startsWith("LIMIT:")) {
        return NextResponse.json({ error: `${label}は100MBまでです` }, { status: 400 });
      }
      throw err;
    }
    lastSavedName = filename;
    return null;
  };

  let lastSavedName = "";
  // If an audio field is present, treat this as a single-audio upload.
  if (audioFile) {
    // Some browsers report an empty type for .m4a/.flac — fall back to the
    // extension so a legitimate file isn't rejected on a missing MIME type.
    const ext = path.extname(audioFile.name).toLowerCase();
    const typeOk =
      ALLOWED_AUDIO.has(audioFile.type) ||
      (!audioFile.type && AUDIO_EXTS.has(ext));
    if (!typeOk) {
      return NextResponse.json(
        { error: `非対応の音声形式です: ${audioFile.type || ext}` },
        { status: 400 }
      );
    }

    // .webm is shared by the video and audio containers, so an audio upload is
    // stored as .weba — that keeps the media route's ext→MIME mapping
    // unambiguous (.webm = video, .weba = audio).
    const safeExt = ext === ".webm" ? ".weba" : AUDIO_EXTS.has(ext) ? ext : ".mp3";
    const reject = await saveOrReject(
      audioFile,
      "音声",
      MAX_AUDIO_BYTES,
      () => `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`
    );
    if (reject) return reject;

    return NextResponse.json(
      { audioUrl: `/api/media/${lastSavedName}` },
      { status: 201 }
    );
  }

  // If a video field is present, treat this as a single-video upload.
  if (videoFile) {
    if (!ALLOWED_VIDEO.has(videoFile.type)) {
      return NextResponse.json(
        { error: `非対応の動画形式です: ${videoFile.type}` },
        { status: 400 }
      );
    }

    const ext = path.extname(videoFile.name) || ".mp4";
    const safeExt = [".mp4", ".webm", ".mov"].includes(ext) ? ext : ".mp4";
    const reject = await saveOrReject(
      videoFile,
      "動画",
      MAX_VIDEO_BYTES,
      () => `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`
    );
    if (reject) return reject;

    return NextResponse.json(
      { videoUrl: `/api/media/${lastSavedName}` },
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

  for (const file of files) {
    if (!ALLOWED.has(file.type)) {
      return NextResponse.json(
        { error: `非対応の画像形式です: ${file.type}` },
        { status: 400 }
      );
    }
  }

  const urls: string[] = [];
  const written: string[] = [];
  for (const file of files) {
    const ext = path.extname(file.name) || ".jpg";
    const safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    const filename = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}${safeExt}`;
    try {
      const reject = await saveOrReject(file, "画像", MAX_BYTES, () => filename);
      if (reject) {
        await Promise.all(
          written.map((n) => rm(path.join(uploadDir, n), { force: true }))
        );
        return reject;
      }
    } catch (err) {
      // Non-LIMIT write failure (ENOSPC etc.): roll back everything written
      // for this request so no orphan files remain, then rethrow (→ 500).
      await Promise.all(
        [...written, filename].map((n) => rm(path.join(uploadDir, n), { force: true }))
      );
      throw err;
    }
    written.push(filename);
    urls.push(`/api/media/${filename}`);
  }

  return NextResponse.json({ urls }, { status: 201 });
}
