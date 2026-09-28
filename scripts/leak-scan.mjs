/**
 * Find member email addresses in an API response — the single implementation
 * shared by the production E2E guard (scripts/e2e-regression.mjs) and its unit
 * test (src/lib/__tests__/leak-scan.test.ts).
 *
 * Every field the SERVER adds is scanned. User-authored content is skipped: a
 * member may type an address into a post, and that is their own text, not a
 * leak by the API (prod had 8 such posts on 2026-09-28).
 *
 * @param {unknown} json parsed response body
 * @returns {string[]} paths of offending fields (empty = clean)
 */
export const USER_CONTENT_KEYS = new Set([
  "text", "body", "bodyMd", "bodyHtml", "comment", "title", "urlPreview", "poll", "bio",
]);
const ADDR = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,}/;
const EMAIL_KEY = /^(author|user|actor|viewer)?[eE]mails?$/;

export function findEmailLeaks(json) {
  const hits = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (EMAIL_KEY.test(k)) hits.push(`${path}.${k} (key)`);
        if (USER_CONTENT_KEYS.has(k)) continue;
        walk(x, `${path}.${k}`);
      }
      return;
    }
    if (typeof v === "string" && ADDR.test(v)) hits.push(path || "(root)");
  };
  walk(json, "");
  return hits;
}
