import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/drinews/image/[filename] — serve drinews header images PUBLICLY.
// No auth required: these images appear in emails, which must render without login.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;

  // Security: reject path traversal
  if (!filename || filename.includes("..") || filename.includes("/")) {
    return NextResponse.json({ error: "不正なパス" }, { status: 400 });
  }

  const uploadDir = path.join(process.cwd(), "public", "uploads", "drinews");
  const filePath = path.join(uploadDir, filename);

  const contentType = mimeFromExt(path.extname(filename));

  try {
    const s = await stat(filePath);
    if (!s.isFile()) throw new Error("not a file");
    const buf = await readFile(filePath);
    return new NextResponse(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(buf.byteLength),
      },
    });
  } catch {
    return NextResponse.json({ error: "画像が見つかりません" }, { status: 404 });
  }
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}
