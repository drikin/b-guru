import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";

// GET /api/avatar/[hash] — proxy + disk-cache Gravatar images.
//
// Why: the timeline renders 30+ avatars per page, each pointing straight at
// www.gravatar.com. That is 30+ cross-origin DNS lookups + TLS handshakes to a
// third party, measured at 900-2,500ms each, and it leaks every member's email
// hash to Automattic on every page view. Proxying through our own origin lets
// the browser reuse the existing connection and lets us cache on disk.
//
// The cache is keyed by the md5 hash (already the Gravatar identifier), so the
// route never sees an email address. `d=404` upstream means "no avatar" is a
// 404, which we cache as a negative result to avoid re-asking.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_DIR = path.join(process.cwd(), "data", "avatar-cache");
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const NEGATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day for "no avatar"
const MAX_CACHE_BYTES = 200 * 1024 * 1024; // 200MB hard cap (disk is at 82%)

// Gravatar identifiers are md5 hex. Anything else is rejected before we build a
// URL, so this route can never be used as an open proxy.
const HASH_RE = /^[a-f0-9]{32}$/;

async function dirSize(dir: string): Promise<number> {
  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(dir);
    let total = 0;
    for (const f of files) {
      try {
        const s = await stat(path.join(dir, f));
        total += s.size;
      } catch {
        /* raced with eviction */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ hash: string }> }
) {
  const { hash } = await params;
  const key = (hash || "").toLowerCase();

  if (!HASH_RE.test(key)) {
    return NextResponse.json({ error: "invalid hash" }, { status: 400 });
  }

  const cachePath = path.join(CACHE_DIR, `${key}.img`);
  const metaPath = path.join(CACHE_DIR, `${key}.meta`);

  // ---- cache hit ----
  try {
    const [buf, metaRaw] = await Promise.all([
      readFile(cachePath),
      readFile(metaPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as { ct: string; ts: number; miss?: boolean };
    const ttl = meta.miss ? NEGATIVE_TTL_MS : CACHE_TTL_MS;
    if (Date.now() - meta.ts < ttl) {
      if (meta.miss) {
        return new NextResponse(null, {
          status: 404,
          headers: { "Cache-Control": "public, max-age=86400" },
        });
      }
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": meta.ct || "image/jpeg",
          "Cache-Control": "public, max-age=604800, immutable",
          "X-Avatar-Cache": "HIT",
        },
      });
    }
  } catch {
    /* cache miss */
  }

  // ---- fetch upstream ----
  const upstream = `https://www.gravatar.com/avatar/${key}?s=250&r=g&d=404`;
  let res: Response;
  try {
    res = await fetch(upstream, {
      headers: { "User-Agent": "bsm-portal/1.0 (+https://bsm.backspace.fm)" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    // Upstream unreachable — do NOT cache, let the client fall back to initials.
    return new NextResponse(null, { status: 404 });
  }

  await mkdir(CACHE_DIR, { recursive: true });

  if (!res.ok) {
    // 404 = member has no Gravatar. Cache the negative result so we stop asking.
    try {
      await writeFile(metaPath, JSON.stringify({ ct: "", ts: Date.now(), miss: true }));
    } catch {
      /* non-fatal */
    }
    return new NextResponse(null, {
      status: 404,
      headers: { "Cache-Control": "public, max-age=86400" },
    });
  }

  const ct = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());

  // Evict before writing when the cache is over budget. Cheap sweep: drop the
  // oldest half by mtime. Runs rarely (only when over the cap).
  try {
    if ((await dirSize(CACHE_DIR)) > MAX_CACHE_BYTES) {
      const { readdir, unlink } = await import("fs/promises");
      const files = await readdir(CACHE_DIR);
      const entries = await Promise.all(
        files.map(async (f) => {
          try {
            const s = await stat(path.join(CACHE_DIR, f));
            return { f, mtime: s.mtimeMs };
          } catch {
            return { f, mtime: 0 };
          }
        })
      );
      entries.sort((a, b) => a.mtime - b.mtime);
      for (const e of entries.slice(0, Math.floor(entries.length / 2))) {
        await unlink(path.join(CACHE_DIR, e.f)).catch(() => {});
      }
    }
  } catch {
    /* eviction is best-effort */
  }

  try {
    await Promise.all([
      writeFile(cachePath, buf),
      writeFile(metaPath, JSON.stringify({ ct, ts: Date.now() })),
    ]);
  } catch {
    /* cache write failure must not break the response */
  }

  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=604800, immutable",
      "X-Avatar-Cache": "MISS",
    },
  });
}
