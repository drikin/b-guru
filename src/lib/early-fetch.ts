/**
 * Early fetch: start the two requests on the first-paint critical path while
 * the JS bundle is still downloading.
 *
 * Measured 2026-09-28 (logged in, 3-run median): the HTML is in at ~390ms, but
 * the feed request only started at ~1,190ms — after the JS (~900ms), hydration,
 * and a full /api/auth/me round trip (every loader waits for `auth`). The first
 * post rendered at ~1,910ms.
 *
 * EARLY_SCRIPT is inlined into <head> (app/layout.tsx), so both fetches start
 * as soon as the HTML is parsed. The client consumes a result through
 * earlyOrFetch() — ONCE, only for the exact same URL, only if fresh and ok —
 * and otherwise falls back to a normal fetch, so behaviour is unchanged when
 * the early result does not apply (club filter in the URL, logged out → 401,
 * user logged in minutes later, etc.).
 */
export const EARLY_AUTH_URL = "/api/auth/me";
export const EARLY_FEED_URL = "/api/posts?limit=50"; // must equal loadFeed()'s default URL
export const EARLY_TTL_MS = 15_000;

/**
 * Also emitted as <link rel="preload" as="fetch"> (app/layout.tsx). Measured
 * after the first deploy: the inline script alone only started at ~665ms,
 * because Next puts the 231KB stylesheet <link>s first in <head> and a classic
 * script waits for pending stylesheets. A preload link is not blocked by CSS,
 * so the request starts as soon as the HTML is parsed; the script's fetch()
 * then picks up the preloaded response. For that match the fetch must use the
 * same mode/credentials (crossorigin="anonymous" ≙ fetch's defaults) and no
 * `cache: "no-store"` — both routes answer with Cache-Control: no-store instead
 * (api/posts and api/auth/me; locked by early-fetch.test.ts).
 * The feed preload is skipped for ?club= links by the script, but a <link> is
 * static; that case costs one unused preload, same as before this change.
 */
export const EARLY_PRELOADS = [EARLY_AUTH_URL, EARLY_FEED_URL] as const;

// Plain ES5, no dependencies: runs before React. A ?club= deep link builds a
// different feed URL, so skip the feed there instead of wasting a request.
export const EARLY_SCRIPT = `(function(){try{var e=window.__bsmEarly={t:Date.now(),p:{}};e.p[${JSON.stringify(
  EARLY_AUTH_URL
)}]=fetch(${JSON.stringify(EARLY_AUTH_URL)});if(!/[?&]club=/.test(location.search)){e.p[${JSON.stringify(
  EARLY_FEED_URL
)}]=fetch(${JSON.stringify(EARLY_FEED_URL)});}}catch(_){}})();`;

type EarlyStore = { t: number; p: Record<string, Promise<Response> | undefined> };

/** Take the early response for `url` (at most once). Null when absent/stale. */
export function takeEarly(url: string, now: number = Date.now()): Promise<Response> | null {
  const e = (globalThis as { __bsmEarly?: EarlyStore }).__bsmEarly;
  const p = e?.p[url];
  if (!e || !p) return null;
  delete e.p[url]; // a Response body can be read once; later calls fetch fresh
  if (now - e.t > EARLY_TTL_MS) return null;
  return p;
}

/** fetch(), but reuse the early response when it applies and succeeded. */
export function earlyOrFetch(url: string, init?: RequestInit): Promise<Response> {
  const p = takeEarly(url);
  if (!p) return fetch(url, init);
  return p.then(
    (r) => (r.ok ? r : fetch(url, init)),
    () => fetch(url, init)
  );
}
