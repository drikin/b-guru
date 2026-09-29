/* Markdown → HTML conversion + sanitization for Dori News. */
import { marked } from "marked";
import { sanitizeHtmlLite } from "./sanitize-lite";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Convert markdown to HTML and sanitize it (safe for rendering / email).
 * Supports headings, lists, bold/italic, links, images, blockquote, code.
 *
 * Sanitization uses our own allow-list implementation rather than
 * `sanitize-html`: this function runs in the browser (timeline rendering), and
 * `sanitize-html` dragged htmlparser2 + postcss (~450KB) into the client
 * bundle. See sanitize-lite.ts for the security model.
 */
export function mdToHtml(md: string): string {
  const key = md || "";
  const hit = htmlCache.get(key);
  if (hit !== undefined) {
    // Refresh recency (Map keeps insertion order → oldest first).
    htmlCache.delete(key);
    htmlCache.set(key, hit);
    return hit;
  }
  const html = sanitizeHtmlLite(marked.parse(key) as string);
  htmlCache.set(key, html);
  if (htmlCache.size > HTML_CACHE_MAX) {
    htmlCache.delete(htmlCache.keys().next().value as string);
  }
  return html;
}

/**
 * Memo for mdToHtml. It is a pure function of `md` (marked options are fixed at
 * module load above), and the timeline calls it for every visible post on every
 * Home re-render — chat SSE, presence polls, badge updates — re-parsing the same
 * text each time. Bounded LRU so a long-lived tab / server process can't grow it
 * without limit. Exported for tests only.
 */
const HTML_CACHE_MAX = 1000;
const htmlCache = new Map<string, string>();
export const __mdCacheForTests = {
  size: () => htmlCache.size,
  has: (md: string) => htmlCache.has(md),
  clear: () => htmlCache.clear(),
  max: HTML_CACHE_MAX,
};

/** Decode the entities sanitize-lite emits, for plaintext output. */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Simple text-only plaintext (for email text body). */
export function mdToPlaintext(md: string): string {
  const html = mdToHtml(md);
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
