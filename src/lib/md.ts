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
  const raw = marked.parse(md || "") as string;
  return sanitizeHtmlLite(raw);
}

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
