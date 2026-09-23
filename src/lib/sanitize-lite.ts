/**
 * Lightweight HTML sanitizer for markdown output.
 *
 * Replaces `sanitize-html`, which pulled htmlparser2 (300KB) + postcss (344KB)
 * into the CLIENT bundle — 621KB of the main chunk, of which ~450KB was this
 * dependency tree. `mdToHtml` runs in the browser (timeline rendering), so the
 * sanitizer has to be small.
 *
 * Design: allow-list, not deny-list. Anything not explicitly permitted is
 * dropped, so a new dangerous tag or attribute is safe by default. This is the
 * same model `sanitize-html` used, which is why the behaviour below matches it.
 *
 * The parser is a small tokenizer, not a full HTML parser. That is deliberate:
 * the input is `marked`'s output (a known, simple shape) plus whatever raw HTML
 * a user typed. Anything the tokenizer does not understand is treated as text
 * and escaped, which fails closed.
 */

/** Tags that may appear in the output. */
const ALLOWED_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "ul", "ol", "li",
  "strong", "em", "b", "i", "a", "img", "blockquote", "code", "pre",
  "hr",
]);

/** Attributes allowed per tag. */
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href", "target", "rel"]),
  img: new Set(["src", "alt"]),
  code: new Set(["class"]),
  pre: new Set(["class"]),
};

/** URL schemes allowed in href/src. */
const ALLOWED_SCHEMES = new Set(["http", "https", "mailto"]);

/**
 * Tags whose *content* must be dropped along with the tag. `<script>bad()</script>`
 * must not leave `bad()` behind as text.
 */
const DROP_CONTENT_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "svg", "math",
  "noscript", "template", "title", "textarea", "select", "option",
]);

/** Void elements: no closing tag, no children. */
const VOID_TAGS = new Set(["br", "hr", "img"]);

/**
 * Escape text so it cannot introduce markup.
 *
 * Existing entities must survive: `marked` emits `&lt;` for a literal `<` the
 * user typed, and re-escaping the `&` would render it as the text "&lt;"
 * instead of "<". Only bare `&` (not already starting an entity) is escaped.
 */
function escapeText(s: string): string {
  return s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape a value for use inside a double-quoted attribute. */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Is this URL safe to emit? Relative URLs and fragments are fine; anything with
 * a scheme must be on the allow-list. `javascript:` and `data:` are rejected.
 */
function isSafeUrl(url: string): boolean {
  const trimmed = url.trim();
  if (trimmed === "") return false;
  // Strip control characters that browsers ignore when parsing schemes
  // (e.g. "java\tscript:alert(1)").
  const cleaned = trimmed.replace(/[\u0000-\u0020]/g, "");
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  if (!m) return true; // relative URL or fragment
  return ALLOWED_SCHEMES.has(m[1].toLowerCase());
}

/** Parse the attributes out of a raw tag body, e.g. `a href="x" target=_blank`. */
function parseAttrs(body: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1].toLowerCase();
    const value = m[2] ?? m[3] ?? m[4] ?? "";
    out.push([name, value]);
  }
  return out;
}

/**
 * Sanitize an HTML string, keeping only allow-listed tags and attributes.
 *
 * Mirrors the behaviour of the `sanitize-html` config this replaced:
 *  - disallowed tags are unwrapped (content kept) unless they are in
 *    DROP_CONTENT_TAGS, in which case the content is dropped too
 *  - `<a>` always gets target="_blank" rel="noopener noreferrer"
 *  - an href/src with a disallowed scheme is removed, the element kept
 */
export function sanitizeHtmlLite(html: string): string {
  const input = html || "";
  let out = "";
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf("<", i);
    if (lt === -1) {
      out += escapeText(input.slice(i));
      break;
    }
    // Text before the tag.
    if (lt > i) out += escapeText(input.slice(i, lt));

    // Comment / doctype / CDATA: drop entirely.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      i = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt);
      i = end === -1 ? input.length : end + 1;
      continue;
    }

    const gt = input.indexOf(">", lt);
    if (gt === -1) {
      // Unterminated tag: treat the rest as text (fail closed).
      out += escapeText(input.slice(lt));
      break;
    }

    let body = input.slice(lt + 1, gt);
    let closing = false;
    if (body.startsWith("/")) {
      closing = true;
      body = body.slice(1);
    }
    const selfClosing = body.endsWith("/");
    if (selfClosing) body = body.slice(0, -1);

    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(body);
    if (!nameMatch) {
      // Not a tag we understand — escape it so it renders as text.
      out += escapeText(input.slice(lt, gt + 1));
      i = gt + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const attrBody = body.slice(nameMatch[1].length);

    if (DROP_CONTENT_TAGS.has(tag)) {
      if (closing) {
        i = gt + 1;
        continue;
      }
      // Skip to the matching close tag (or the end).
      const closeRe = new RegExp(`</${tag}\\s*>`, "i");
      const rest = input.slice(gt + 1);
      const cm = closeRe.exec(rest);
      i = cm ? gt + 1 + cm.index + cm[0].length : input.length;
      continue;
    }

    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap: drop the tag, keep the content.
      i = gt + 1;
      continue;
    }

    if (closing) {
      if (!VOID_TAGS.has(tag)) out += `</${tag}>`;
      i = gt + 1;
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag];
    const attrs: Array<[string, string]> = [];
    if (allowed) {
      for (const [rawName, value] of parseAttrs(attrBody)) {
        if (!allowed.has(rawName)) continue;
        if (rawName === "href" || rawName === "src") {
          if (!isSafeUrl(value)) continue;
        }
        attrs.push([rawName, value]);
      }
    }

    if (tag === "a") {
      // Force safe link behaviour, overriding whatever was supplied.
      const filtered = attrs.filter(([n]) => n !== "target" && n !== "rel");
      filtered.push(["target", "_blank"], ["rel", "noopener noreferrer"]);
      attrs.length = 0;
      attrs.push(...filtered);
    }

    const rendered = attrs.map(([n, v]) => ` ${n}="${escapeAttr(v)}"`).join("");
    out += VOID_TAGS.has(tag) ? `<${tag}${rendered} />` : `<${tag}${rendered}>`;
    i = gt + 1;
  }

  return out;
}
