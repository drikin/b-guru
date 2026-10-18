/* Chat photo attachments — client-side preparation before upload.
 *
 * Photos are resized in the browser so the long side is at most
 * CHAT_PHOTO_MAX_SIDE and re-encoded as JPEG (which also drops EXIF/GPS) before
 * they go to POST /api/chat/upload. Limits mirror the server's CHAT_UPLOAD in
 * lib/upload.ts (4 photos, 4 MB each). Pure helpers are exported for tests. */

export const CHAT_MAX_PHOTOS = 4;
export const CHAT_PHOTO_MAX_SIDE = 1280;
export const CHAT_PHOTO_MAX_BYTES = 4 * 1024 * 1024;
export const CHAT_PHOTO_QUALITY = 0.8;

/** Scale (w, h) down so the long side is ≤ max (never upscales). */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  const long = Math.max(w, h);
  if (!(long > max)) return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
  const s = max / long;
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** How many of `incoming` still fit next to `current` attached photos. */
export function photoSlots(current: number, incoming: number): number {
  return Math.max(0, Math.min(incoming, CHAT_MAX_PHOTOS - current));
}

/** Image files out of a FileList / array (drops non-images). */
export function imageFiles(files: FileList | File[] | null | undefined): File[] {
  if (!files) return [];
  return Array.from(files).filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
}

type Decoded = { source: CanvasImageSource; width: number; height: number; close: () => void };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === "function") {
    // imageOrientation "from-image" applies EXIF rotation; older Safari rejects
    // the options bag, so retry without it before falling back to <img>.
    for (const opts of [{ imageOrientation: "from-image" } as ImageBitmapOptions, undefined]) {
      try {
        const bmp = opts ? await createImageBitmap(file, opts) : await createImageBitmap(file);
        return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
      } catch {
        /* try the next decoder */
      }
    }
  }
  // <img> decoding honours EXIF orientation by default in modern browsers and
  // can read formats createImageBitmap may not (e.g. HEIC on Safari).
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return {
      source: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      close: () => URL.revokeObjectURL(url),
    };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

function toJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode failed"))), "image/jpeg", quality)
  );
}

/** Resize + re-encode one photo for chat. Small GIFs pass through untouched
 *  (keeps animation); everything else becomes a ≤1280 px JPEG. */
export async function prepareChatPhoto(file: File): Promise<Blob> {
  if (file.type === "image/gif" && file.size <= CHAT_PHOTO_MAX_BYTES) return file;
  const d = await decode(file);
  try {
    const { width, height } = fitWithin(d.width, d.height, CHAT_PHOTO_MAX_SIDE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    // JPEG has no alpha: paint white under transparent PNG/WebP/GIF pixels.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(d.source, 0, 0, width, height);
    let blob = await toJpeg(canvas, CHAT_PHOTO_QUALITY);
    if (blob.size > CHAT_PHOTO_MAX_BYTES) blob = await toJpeg(canvas, 0.6);
    return blob;
  } finally {
    d.close();
  }
}

/** Upload prepared photos → server urls. Throws Error(message) on failure;
 *  `status` is set on the error for HTTP failures (4xx = don't retry). */
export async function uploadChatPhotos(blobs: Blob[], signal?: AbortSignal): Promise<string[]> {
  const form = new FormData();
  blobs.forEach((b, i) => {
    const ext = b.type === "image/gif" ? "gif" : b.type === "image/png" ? "png" : b.type === "image/webp" ? "webp" : "jpg";
    form.append("images", b, `photo-${i + 1}.${ext}`);
  });
  const r = await fetch("/api/chat/upload", { method: "POST", body: form, cache: "no-store", signal });
  const d = await r.json().catch(() => null);
  if (r.ok && Array.isArray(d?.urls)) return d.urls as string[];
  const err = new Error(typeof d?.error === "string" ? d.error : "写真を送れませんでした") as Error & { status?: number };
  err.status = r.status;
  throw err;
}
