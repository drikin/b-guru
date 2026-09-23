import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";

// GET /api/img?u=<encoded-url> — proxy + disk-cache external preview images.
//
// Why: the timeline renders 100+ external images per page (YouTube thumbnails,
// Twitter cards, news-site og:image) straight from third-party origins. Each one
// costs a fresh DNS lookup + TLS handshake to a different host, measured at
// 3,000-8,500ms, and they compete with our own API calls for the browser's
// 6-connections-per-host budget. Proxying through our origin collapses all of
// them onto one already-open connection and lets us cache on disk.
//
// Security: this is NOT an open proxy. Only http/https URLs whose host is in
// the allowlist below are fetched, redirects are followed manually and
// re-validated against the same allowlist, and private/loopback address space
// is rejected. Responses must be an image content-type.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_DIR = path.join(process.cwd(), "data", "img-cache");
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_CACHE_BYTES = 500 * 1024 * 1024; // 500MB hard cap (disk is at 82%)
const MAX_BYTES = 8 * 1024 * 1024; // refuse images over 8MB
const MAX_REDIRECTS = 3;

// Hosts that actually appear in url_preview.image across the posts table.
// Suffix match, so "i.ytimg.com" also covers "foo.i.ytimg.com".
const ALLOWED_HOSTS = [
  "ytimg.com",
  "ggpht.com",
  "youtube.com",
  "twimg.com",
  "githubassets.com",
  "githubusercontent.com",
  "huggingface.co",
  "st-note.com",
  "note.com",
  "backspace.fm",
  "loom-app.com",
  "theverge.com",
  "techcrunch.com",
  "cnet.com",
  "itmedia.co.jp",
  "impress.co.jp",
  "watch.impress.co.jp",
  "nikkei.com",
  "gzn.jp",
  "macotakara.jp",
  "techno-edge.net",
  "xenospectrum.com",
  "joho-todai.com",
  "spotifycdn.com",
  "scdn.co",
  "cloudfront.net",
  "amazonaws.com",
  "imgur.com",
  "redd.it",
  "reddit.com",
  "medium.com",
  "substack.com",
  "substackcdn.com",
  "qiita.com",
  "zenn.dev",
  "hatenablog.com",
  "hatena.ne.jp",
  "speakerdeck.com",
  "slideshare.net",
  "vimeo.com",
  "vimeocdn.com",
  "soundcloud.com",
  "sndcdn.com",
  "art19.com",
  "simplecast.com",
  "megaphone.fm",
  "libsyn.com",
  "podbean.com",
  "anchor.fm",
  "bunnycdn.com",
  "wp.com",
  "wordpress.com",
  "gravatar.com",
];

function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  // Reject anything that looks like an internal address before allowlisting.
  if (
    h === "localhost" ||
    h.endsWith(".local") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(h) ||
    h.includes(":") // IPv6 literal
  ) {
    return false;
  }
  return ALLOWED_HOSTS.some((a) => h === a || h.endsWith("." + a));
}

async function dirSize(dir: string): Promise<number> {
  try {
    const { readdir } = await import("fs/promises");
    const files = await readdir(dir);
    let total = 0;
    for (const f of files) {
      try {
        total += (await stat(path.join(dir, f))).size;
      } catch {
        /* raced with eviction */
      }
    }
    return total;
  } catch {
    return 0;
  }
}

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("u");
  if (!raw) {
    return NextResponse.json({ error: "u is required" }, { status: 400 });
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return NextResponse.json({ error: "invalid protocol" }, { status: 400 });
  }
  if (!hostAllowed(target.hostname)) {
    return NextResponse.json({ error: "host not allowed" }, { status: 403 });
  }

  const key = createHash("sha256").update(target.toString()).digest("hex");
  const cachePath = path.join(CACHE_DIR, `${key}.img`);
  const metaPath = path.join(CACHE_DIR, `${key}.meta`);

  // ---- cache hit ----
  try {
    const [buf, metaRaw] = await Promise.all([
      readFile(cachePath),
      readFile(metaPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as { ct: string; ts: number };
    if (Date.now() - meta.ts < CACHE_TTL_MS) {
      return new NextResponse(new Uint8Array(buf), {
        status: 200,
        headers: {
          "Content-Type": meta.ct || "image/jpeg",
          "Cache-Control": "public, max-age=1209600, immutable",
          "X-Img-Cache": "HIT",
        },
      });
    }
  } catch {
    /* cache miss */
  }

  // ---- fetch upstream, following redirects manually so each hop is validated ----
  let current = target;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let r: Response;
    try {
      r = await fetch(current.toString(), {
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; bsm-portal/1.0; +https://bsm.backspace.fm)",
          Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return new NextResponse(null, { status: 502 });
    }

    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return new NextResponse(null, { status: 502 });
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        return new NextResponse(null, { status: 502 });
      }
      if (!hostAllowed(next.hostname)) {
        return NextResponse.json({ error: "redirect host not allowed" }, { status: 403 });
      }
      current = next;
      continue;
    }
    res = r;
    break;
  }

  if (!res || !res.ok) {
    return new NextResponse(null, { status: 404 });
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.startsWith("image/")) {
    return NextResponse.json({ error: "not an image" }, { status: 415 });
  }

  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: "too large" }, { status: 413 });
  }

  await mkdir(CACHE_DIR, { recursive: true });

  // Evict the oldest half when over budget (best-effort, runs rarely).
  try {
    if ((await dirSize(CACHE_DIR)) > MAX_CACHE_BYTES) {
      const { readdir, unlink } = await import("fs/promises");
      const files = await readdir(CACHE_DIR);
      const entries = await Promise.all(
        files.map(async (f) => {
          try {
            return { f, mtime: (await stat(path.join(CACHE_DIR, f))).mtimeMs };
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
      "Cache-Control": "public, max-age=1209600, immutable",
      "X-Img-Cache": "MISS",
    },
  });
}
