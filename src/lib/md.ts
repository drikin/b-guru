/* Markdown → HTML conversion + sanitization for Dori News. */
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/**
 * Convert markdown to HTML and sanitize it (safe for rendering / email).
 * Supports headings, lists, bold/italic, links, images, blockquote, code.
 */
export function mdToHtml(md: string): string {
  const raw = marked.parse(md || "") as string;
  return sanitizeHtml(raw, {
    allowedTags: [
      "p", "br", "h1", "h2", "h3", "h4", "ul", "ol", "li",
      "strong", "em", "b", "i", "a", "img", "blockquote", "code", "pre",
      "hr",
    ],
    allowedAttributes: {
      a: ["href", "target", "rel"],
      img: ["src", "alt"],
      code: ["class"],
      pre: ["class"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { target: "_blank", rel: "noopener noreferrer" }),
    },
  });
}

/** Simple text-only plaintext (for email text body). */
export function mdToPlaintext(md: string): string {
  const html = mdToHtml(md);
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
