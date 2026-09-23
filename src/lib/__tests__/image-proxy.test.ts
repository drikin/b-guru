import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Regression tests for the image/avatar proxy work.
//
// Background: the timeline rendered 100+ third-party images and 30+ Gravatar
// avatars straight from their origins. Each cost a fresh DNS lookup + TLS
// handshake (measured 3,000-8,500ms for images, 900-2,500ms for avatars) and
// they competed with our own API calls for the browser's 6-connections-per-host
// budget. These tests pin the invariants that keep them on our origin.

const ROOT = path.resolve(__dirname, "../../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

describe("gravatarUrl returns a same-origin proxy path", () => {
  it("never emits a gravatar.com URL", () => {
    const src = read("src/lib/posts.ts");
    const fn = src.slice(src.indexOf("export function gravatarUrl"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).not.toContain("gravatar.com");
    expect(body).toContain("/api/avatar/");
  });

  it("still short-circuits the system poster to the app icon", () => {
    const src = read("src/lib/posts.ts");
    const fn = src.slice(src.indexOf("export function gravatarUrl"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("/icon-192.png");
  });
});

describe("/api/avatar route", () => {
  const src = read("src/app/api/avatar/[hash]/route.ts");

  it("rejects anything that is not an md5 hex hash (no open proxy)", () => {
    expect(src).toContain("HASH_RE");
    expect(src).toMatch(/\[a-f0-9\]\{32\}/);
  });

  it("caches on disk with a TTL and a size cap", () => {
    expect(src).toContain("CACHE_TTL_MS");
    expect(src).toContain("MAX_CACHE_BYTES");
    expect(src).toContain("NEGATIVE_TTL_MS");
  });

  it("caches the no-avatar 404 so we stop re-asking upstream", () => {
    expect(src).toContain("miss: true");
  });
});

describe("/api/img route", () => {
  const src = read("src/app/api/img/route.ts");

  it("is not an open proxy: blocks private address space (SSRF)", () => {
    expect(src).toContain("isPrivateIp");
    expect(src).toContain("hostIsSafe");
    expect(src).toContain('target.protocol !== "http:"');
    // DNS is resolved by us so the real IP can be checked before connecting.
    expect(src).toContain('from "dns/promises"');
  });

  it("blocks loopback, link-local, CGNAT and cloud-metadata ranges", () => {
    expect(src).toContain("a === 127");
    expect(src).toContain("a === 10");
    expect(src).toContain("a === 169 && b === 254"); // 169.254.169.254 metadata
    expect(src).toContain("a === 172 && b >= 16 && b <= 31");
    expect(src).toContain("a === 192 && b === 168");
    expect(src).toContain("a === 100 && b >= 64 && b <= 127");
    expect(src).toContain('v === "::1"');
    expect(src).toContain("fe80");
  });

  it("refuses unresolvable hosts and .local/.internal names", () => {
    expect(src).toContain('h === "localhost"');
    expect(src).toContain(".local");
    expect(src).toContain(".internal");
  });

  it("re-validates every redirect hop against the same checks", () => {
    expect(src).toContain("MAX_REDIRECTS");
    expect(src).toContain('redirect: "manual"');
    expect(src).toContain("redirect host not allowed");
    expect(src).toContain("invalid redirect protocol");
  });

  it("only serves image content-types and caps the size", () => {
    expect(src).toContain('ct.startsWith("image/")');
    expect(src).toContain("MAX_BYTES");
  });
});

describe("no API route leaks a raw gravatar.com URL to the client", () => {
  // Ghost's `avatar_image` is a full https://www.gravatar.com/avatar/<md5> URL.
  // Passing it straight through made the client fetch avatars cross-origin
  // (900-2,500ms each) and leaked every member's email hash to Automattic.
  // Every route that surfaces an avatar must rewrite it to /api/avatar/<md5>.
  const ROUTES = [
    "src/app/api/members/route.ts",
    "src/app/api/auth/me/route.ts",
    "src/app/api/bsm/member-check/route.ts",
  ];

  for (const rel of ROUTES) {
    it(`${rel} rewrites gravatar URLs to the same-origin proxy`, () => {
      const src = read(rel);
      // It may mention gravatar.com in a comment/regex, but it must never
      // assign a raw avatar_image straight into the response.
      expect(src).not.toMatch(/avatar:\s*m\.avatar_image\s*\|\|\s*null/);
      expect(src).not.toMatch(/avatar\s*=\s*member\.avatar_image\s*\|\|\s*null/);
      expect(src).toContain("/api/avatar/");
    });
  }
});

describe("page.tsx routes external images through the proxy", () => {
  const src = read("src/app/page.tsx");

  it("defines proxiedImage and leaves same-origin paths alone", () => {
    expect(src).toContain("function proxiedImage");
    const fn = src.slice(src.indexOf("function proxiedImage"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("/^https?:\\/\\//i.test(src)");
    expect(body).toContain("/api/img?u=");
  });

  it("applies it to the url-preview image, profile header and lightbox", () => {
    expect(src).toContain("proxiedImage(post.urlPreview.image)");
    expect(src).toContain("proxiedImage(profile.headerImage)");
    expect(src).toContain("proxiedImage(previewImage)");
  });

  it("does not render a raw external urlPreview.image", () => {
    expect(src).not.toContain("src={post.urlPreview.image}");
  });
});
