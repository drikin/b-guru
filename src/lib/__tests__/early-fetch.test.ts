/**
 * Early fetch (lib/early-fetch.ts): the inline <head> script and the one-shot,
 * fresh-and-ok-only consumption rules.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EARLY_SCRIPT,
  EARLY_AUTH_URL,
  EARLY_FEED_URL,
  EARLY_TTL_MS,
  EARLY_PRELOADS,
  takeEarly,
  earlyOrFetch,
} from "../early-fetch";

type G = { __bsmEarly?: unknown; fetch: typeof fetch; location?: unknown };
const g = globalThis as unknown as G;

function runScript(search: string) {
  const calls: string[] = [];
  const fakeFetch = (u: string) => {
    calls.push(u);
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  // Evaluate the exact inlined string with a fake window/location/fetch.
  new Function("window", "location", "fetch", EARLY_SCRIPT)(g, { search }, fakeFetch);
  return calls;
}

beforeEach(() => {
  delete g.__bsmEarly;
});

describe("EARLY_SCRIPT", () => {
  it("starts auth/me and the default feed", () => {
    expect(runScript("")).toEqual([EARLY_AUTH_URL, EARLY_FEED_URL]);
  });
  it("skips the feed on a ?club= deep link (its feed URL differs)", () => {
    expect(runScript("?club=motorsport")).toEqual([EARLY_AUTH_URL]);
  });
  it("never throws even if fetch is missing", () => {
    expect(() => new Function("window", "location", "fetch", EARLY_SCRIPT)(g, { search: "" }, undefined)).not.toThrow();
  });
});

describe("preload match", () => {
  it("early fetches use fetch defaults so they reuse the <link rel=preload> response", () => {
    // A `cache: "no-store"` (or other init) would stop the browser from
    // matching the preload and issue a second request.
    const inits: unknown[] = [];
    new Function("window", "location", "fetch", EARLY_SCRIPT)(g, { search: "" }, (_u: string, init?: unknown) => {
      inits.push(init);
      return Promise.resolve(new Response("{}"));
    });
    expect(inits).toEqual([undefined, undefined]);
  });

  it("layout preloads exactly the early URLs", () => {
    const layout = readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    expect(layout).toMatch(/for \(const u of EARLY_PRELOADS\) preload\(u, \{ as: "fetch", crossOrigin: "anonymous" \}\)/);
    expect(EARLY_PRELOADS).toEqual([EARLY_AUTH_URL, EARLY_FEED_URL]);
  });
});

describe("early URLs are never HTTP-cached", () => {
  it("both routes send Cache-Control: no-store on every response", () => {
    for (const f of ["src/app/api/auth/me/route.ts", "src/app/api/posts/route.ts"]) {
      const src = readFileSync(path.join(process.cwd(), f), "utf8");
      expect(src).toMatch(/Cache-Control": "no-store/);
      const jsonCalls = src.match(/NextResponse\.json\(/g)?.length ?? 0;
      const withHeader = src.match(/headers: NO_CACHE/g)?.length ?? 0;
      expect(withHeader, f).toBeGreaterThanOrEqual(jsonCalls);
    }
  });
});

describe("EARLY_FEED_URL matches loadFeed()'s default request", () => {
  it("uses the same page size as FEED_PAGE in page.tsx", () => {
    const src = readFileSync(path.join(process.cwd(), "src/app/page.tsx"), "utf8");
    const m = src.match(/const FEED_PAGE = (\d+);/);
    expect(m).not.toBeNull();
    expect(EARLY_FEED_URL).toBe(`/api/posts?limit=${m![1]}`);
    // and the loaders really consume the early responses
    expect(src).toContain('earlyOrFetch("/api/auth/me")');
    expect(src).toContain("earlyOrFetch(`/api/posts${q}`");
  });
});

describe("takeEarly / earlyOrFetch", () => {
  it("hands the early response out once, then null", () => {
    runScript("");
    expect(takeEarly(EARLY_AUTH_URL)).not.toBeNull();
    expect(takeEarly(EARLY_AUTH_URL)).toBeNull();
  });

  it("ignores a stale early response (e.g. logged in long after page load)", () => {
    runScript("");
    const t0 = (g.__bsmEarly as { t: number }).t;
    expect(takeEarly(EARLY_FEED_URL, t0 + EARLY_TTL_MS + 1)).toBeNull();
  });

  it("only matches the exact URL", () => {
    runScript("");
    expect(takeEarly("/api/posts?limit=50&club=x")).toBeNull();
  });

  it("refetches when the early response is not ok (401 before login)", async () => {
    g.__bsmEarly = { t: Date.now(), p: { "/x": Promise.resolve(new Response("", { status: 401 })) } };
    const real = vi.fn(async () => new Response("fresh", { status: 200 }));
    const orig = g.fetch;
    g.fetch = real as unknown as typeof fetch;
    try {
      const r = await earlyOrFetch("/x", { cache: "no-store" });
      expect(await r.text()).toBe("fresh");
      expect(real).toHaveBeenCalledWith("/x", { cache: "no-store" });
    } finally {
      g.fetch = orig;
    }
  });

  it("refetches when the early request rejected (network error)", async () => {
    const rejected = Promise.reject(new Error("net"));
    rejected.catch(() => {});
    g.__bsmEarly = { t: Date.now(), p: { "/y": rejected } };
    const real = vi.fn(async () => new Response("ok", { status: 200 }));
    const orig = g.fetch;
    g.fetch = real as unknown as typeof fetch;
    try {
      expect(await (await earlyOrFetch("/y")).text()).toBe("ok");
    } finally {
      g.fetch = orig;
    }
  });

  it("uses the early response without a second request when ok", async () => {
    g.__bsmEarly = { t: Date.now(), p: { "/z": Promise.resolve(new Response("early", { status: 200 })) } };
    const real = vi.fn();
    const orig = g.fetch;
    g.fetch = real as unknown as typeof fetch;
    try {
      expect(await (await earlyOrFetch("/z")).text()).toBe("early");
      expect(real).not.toHaveBeenCalled();
    } finally {
      g.fetch = orig;
    }
  });
});
