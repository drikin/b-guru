/* アップロードの正本（Web の /api/upload とアプリの /api/agent/upload で共通）。 */
import { NextResponse } from "next/server";
import { rm, mkdir, writeFile } from "fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "path";
import crypto from "crypto";
import { POST_IMAGE_MAX_SIDE, canPassThrough, extForFormat, imageInfo, resizeImage } from "./image-resize";


const MAX_IMAGES = 5;
/** /api/agent/upload: the whole request (up to 5 resized photos). */
const APP_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
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
/** Chat photos: small (long side 1280 px, resized on the device), at most 4 a message.
 *  Saved as chat-… so they can be found and deleted with the 24 h chat. */
export const CHAT_UPLOAD = { prefix: "chat-", maxImages: 4, maxImageBytes: 4 * 1024 * 1024, maxTotalBytes: 17 * 1024 * 1024 };

export async function handleUpload(
  req: Request,
  _email: string,
  opts: { imagesOnly?: boolean; chat?: boolean } = {}
): Promise<NextResponse> {
  const chat = !!opts.chat;
  const maxImages = chat ? CHAT_UPLOAD.maxImages : MAX_IMAGES;
  const maxImageBytes = chat ? CHAT_UPLOAD.maxImageBytes : MAX_BYTES;
  // Apps send phone photos resized to ~1 MB each: refuse anything far larger
  // before the multipart body is buffered in memory.
  if (opts.imagesOnly || chat) {
    const limit = chat ? CHAT_UPLOAD.maxTotalBytes : APP_UPLOAD_MAX_BYTES;
    const len = Number(req.headers.get("content-length") ?? "0");
    if (!len || len > limit) {
      return NextResponse.json({ error: chat ? "写真が大きすぎます" : "画像が大きすぎます（合計 50MB まで）" }, { status: 413 });
    }
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
  if ((opts.imagesOnly || chat) && (videoFile || audioFile)) {
    return NextResponse.json({ error: "画像だけ送れます" }, { status: 400 });
  }

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
      return NextResponse.json({ error: `${label}は${Math.round(maxBytes / 1048576)}MBまでです` }, { status: 400 });
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
        return NextResponse.json({ error: `${label}は${Math.round(maxBytes / 1048576)}MBまでです` }, { status: 400 });
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
  if (files.length > maxImages) {
    return NextResponse.json({ error: `画像は最大${maxImages}枚までです` }, { status: 400 });
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
    const ext = path.extname(file.name).toLowerCase() || ".jpg";
    let safeExt = [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
    const base = `${chat ? CHAT_UPLOAD.prefix : ""}${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    let filename = `${base}${safeExt}`;
    try {
      // Post images (not chat: those are already ≤1280 px and EXIF-free from the
      // browser) are stored at most POST_IMAGE_MAX_SIDE on the long side, rotated
      // upright and with EXIF/GPS removed. Anything sharp cannot handle (GIF,
      // animations, odd files) is stored as sent, like before.
      if (!chat && file.size <= maxImageBytes) {
        const prepared = await preparePostImage(Buffer.from(await file.arrayBuffer()));
        if (prepared.ext) safeExt = prepared.ext;
        filename = `${base}${safeExt}`;
        try {
          await writeFile(path.join(uploadDir, filename), prepared.data);
        } catch (err) {
          await rm(path.join(uploadDir, filename), { force: true });
          throw err;
        }
        written.push(filename);
        urls.push(`/api/media/${filename}`);
        continue;
      }
      const reject = await saveOrReject(file, "画像", maxImageBytes, () => filename);
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

/** Normalise one post image for storage: ≤ POST_IMAGE_MAX_SIDE, upright, no EXIF/XMP/IPTC.
 *  Returns the bytes to store and, when re-encoded, the extension of the real format
 *  (a .jpg that is really a PNG is stored as .png so /api/media sends the right type).
 *  Falls back to the bytes as sent when sharp cannot read them. */
export async function preparePostImage(buf: Buffer): Promise<{ data: Buffer; ext?: string }> {
  try {
    const info = await imageInfo(buf);
    if (canPassThrough(info, POST_IMAGE_MAX_SIDE)) return { data: buf };
    const out = await resizeImage(buf, POST_IMAGE_MAX_SIDE);
    return { data: out.data, ext: extForFormat(out.format) || undefined };
  } catch (err) {
    console.warn("[upload] image not processed, stored as sent:", err instanceof Error ? err.message : err);
    return { data: buf };
  }
}
