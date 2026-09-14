import { NextRequest, NextResponse } from "next/server";
import { open, stat } from "fs/promises";
import path from "path";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/media/[filename] — serve uploaded media from disk.
// Avoids the `public/` build-manifest 404 problem for runtime-uploaded files.
//
// Supports HTTP Range requests (206 Partial Content). Audio/video players need
// this to seek/scrub: without it the browser must download the whole file
// before the seek bar works, and some browsers disable seeking entirely.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  // Uploaded media requires auth (same as posting)
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });
  }

  const { filename } = await params;

  // Security: only allow the uploads directory & reject path traversal
  if (!filename || filename.includes("..") || filename.includes("/")) {
    return NextResponse.json({ error: "不正なパス" }, { status: 400 });
  }

  const uploadDir = path.join(process.cwd(), "public", "uploads");
  const filePath = path.join(uploadDir, filename);

  const ext = path.extname(filename).toLowerCase();
  const contentType = mimeFromExt(ext);

  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error("not a file");
    const size = s.size;

    const baseHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };

    // ---- Range request (seek/scrub) ----
    const range = req.headers.get("range");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const hasStart = m[1] !== "";
        const hasEnd = m[2] !== "";
        let start: number;
        let end: number;
        if (hasStart) {
          start = Number(m[1]);
          end = hasEnd ? Number(m[2]) : size - 1;
        } else {
          // Suffix range: "bytes=-N" → last N bytes
          const suffix = Number(m[2]);
          start = Math.max(0, size - suffix);
          end = size - 1;
        }
        // Clamp to the file bounds; an unsatisfiable range → 416.
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start > end ||
          start >= size
        ) {
          return new NextResponse(null, {
            status: 416,
            headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
          });
        }
        if (end >= size) end = size - 1;

        const length = end - start + 1;
        const fh = await open(filePath, "r");
        try {
          const buf = Buffer.alloc(length);
          await fh.read(buf, 0, length, start);
          return new NextResponse(new Uint8Array(buf), {
            status: 206,
            headers: {
              ...baseHeaders,
              "Content-Range": `bytes ${start}-${end}/${size}`,
              "Content-Length": String(length),
            },
          });
        } finally {
          await fh.close();
        }
      }
    }

    // ---- Full response ----
    const fh = await open(filePath, "r");
    try {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(size) },
      });
    } finally {
      await fh.close();
    }
  } catch {
    return NextResponse.json({ error: "メディアが見つかりません" }, { status: 404 });
  }
}

function mimeFromExt(ext: string): string {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    case ".mp4": return "video/mp4";
    // .webm is a container used by BOTH video and audio uploads. The upload
    // route stores audio as .weba (see upload/route.ts) so a .webm here is
    // always video; audio/webm is served from .weba.
    case ".webm": return "video/webm";
    case ".weba": return "audio/webm";
    case ".mov": return "video/quicktime";
    case ".mp3": return "audio/mpeg";
    case ".m4a": return "audio/mp4";
    case ".aac": return "audio/aac";
    case ".wav": return "audio/wav";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".opus": return "audio/ogg";
    case ".flac": return "audio/flac";
    default: return "application/octet-stream";
  }
}
