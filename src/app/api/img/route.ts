import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { mkdir, readFile, writeFile, stat } from "fs/promises";
import path from "path";
import { lookup } from "dns/promises";
import net from "net";

// GET /api/img?u=<encoded-url> — proxy + disk-cache external preview images.
//
// Why: the timeline renders 100+ external images per page (YouTube thumbnails,
// Twitter cards, news-site og:image) straight from third-party origins. Each one
// costs a fresh DNS lookup + TLS handshake to a different host, measured at
// 3,000-8,500ms, and they compete with our own API calls for the browser's
// 6-connections-per-host budget. Proxying through our origin collapses all of
// them onto one already-open HTTP/2 connection and lets us cache on disk.
//
// Security model: DENY-list, not allow-list. The posts table references 156
// distinct image hosts and grows with every link posted, so an allow-list would
// silently break new posts. Instead we block the things that make an open proxy
// dangerous — private/loopback/link-local address space (SSRF), non-http(s)
// schemes, non-image responses, oversized bodies — and resolve DNS ourselves to
// check the actual IP before connecting.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CACHE_DIR = path.join(process.cwd(), "data", "img-cache");
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const MAX_CACHE_BYTES = 500 * 1024 * 1024; // 500MB hard cap (disk is at 82%)
const MAX_BYTES = 8 * 1024 * 1024; // refuse images over 8MB
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 12000;

// Upstream concurrency cap.
//
// The timeline fires ~40 /api/img requests at once. Without a cap, all 40 miss
// the cache simultaneously and open 40 outbound TLS connections to third-party
// hosts; measured TTFB was 2,000-3,200ms per image because the box was
// thrashing on connection setup rather than transferring bytes. Queueing them
// through a small pool keeps each individual image fast (the first ones return
// in ~200ms) and the total wall time is lower than the unbounded case.
const MAX_UPSTREAM_CONCURRENCY = 8;
let activeUpstream = 0;
const upstreamQueue: Array<() => void> = [];

async function acquireUpstreamSlot(): Promise<void> {
  if (activeUpstream < MAX_UPSTREAM_CONCURRENCY) {
    activeUpstream++;
    return;
  }
  await new Promise<void>((resolve) => upstreamQueue.push(resolve));
  activeUpstream++;
}

function releaseUpstreamSlot(): void {
  activeUpstream--;
  const next = upstreamQueue.shift();
  if (next) next();
}

/** True when `ip` is in private, loopback, link-local or otherwise
 * non-routable space. Blocks SSRF against the VPS itself and the LAN. */
function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::") return true;
    if (v.startsWith("fe80")) return true; // link-local
    if (v.startsWith("fc") || v.startsWith("fd")) return true; // unique local
    if (v.startsWith("::ffff:")) return isPrivateIp(v.slice(7)); // v4-mapped
    return false;
  }
  return true; // unparseable → refuse
}

/** Resolve the host and refuse if ANY resolved address is private. */
async function hostIsSafe(hostname: string): Promise<boolean> {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) {
    return false;
  }
  // A literal IP in the URL: check it directly, no DNS.
  if (net.isIP(h)) return !isPrivateIp(h);

  try {
    const addrs = await lookup(h, { all: true });
    if (!addrs.length) return false;
    return addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false; // unresolvable → refuse
  }
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
  if (!(await hostIsSafe(target.hostname))) {
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
  await acquireUpstreamSlot();
  try {
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
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          return NextResponse.json({ error: "invalid redirect protocol" }, { status: 403 });
        }
        if (!(await hostIsSafe(next.hostname))) {
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
  } finally {
    releaseUpstreamSlot();
  }
}
