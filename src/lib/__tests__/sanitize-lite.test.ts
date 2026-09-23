import { describe, it, expect } from "vitest";
import { sanitizeHtmlLite } from "../sanitize-lite";

/**
 * These cases were captured by running the OLD implementation
 * (`sanitize-html` with the config in md.ts) over the same inputs. The new
 * sanitizer must produce equivalent output, so the replacement is provably
 * behaviour-preserving rather than "looks fine on the happy path".
 *
 * Where the new output differs cosmetically (self-closing slash, attribute
 * order) the assertion normalises it — the *meaning* must match.
 */

/** Normalise cosmetic differences so we compare semantics, not formatting. */
function norm(html: string): string {
  return html
    .replace(/\s*\/>/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

describe("sanitizeHtmlLite: matches the previous sanitize-html behaviour", () => {
  const cases: Array<[string, string]> = [
    // [input, expected output from the old implementation]
    ["<h1>見出し</h1>", "<h1>見出し</h1>"],
    [
      "<p><strong>太字</strong> と <em>斜体</em> と <code>code</code></p>",
      "<p><strong>太字</strong> と <em>斜体</em> と <code>code</code></p>",
    ],
    [
      '<p><a href="https://example.com">リンク</a></p>',
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">リンク</a></p>',
    ],
    [
      '<p><img src="https://example.com/a.png" alt="画像"></p>',
      '<p><img src="https://example.com/a.png" alt="画像"></p>',
    ],
    ["<ul><li>リスト1</li><li>リスト2</li></ul>", "<ul><li>リスト1</li><li>リスト2</li></ul>"],
    ["<blockquote><p>引用</p></blockquote>", "<blockquote><p>引用</p></blockquote>"],
    [
      '<pre><code class="language-js">const a=1;</code></pre>',
      '<pre><code class="language-js">const a=1;</code></pre>',
    ],
    ["<hr>", "<hr>"],
    ["<p>a<br>b</p>", "<p>a<br>b</p>"],
    // Disallowed tags are unwrapped, content kept.
    ["<h5>h5は許可外</h5>", "h5は許可外"],
    ["<table><tr><td>t</td></tr></table>", "t"],
    // Escaped entities stay escaped.
    ["<p>&lt;script&gt;</p>", "<p>&lt;script&gt;</p>"],
  ];

  for (const [input, expected] of cases) {
    it(`keeps: ${input.slice(0, 50)}`, () => {
      expect(norm(sanitizeHtmlLite(input))).toBe(norm(expected));
    });
  }
});

describe("sanitizeHtmlLite: drops dangerous content", () => {
  it("removes script tags AND their content", () => {
    // The old implementation returned "" here — the body must not survive as text.
    expect(sanitizeHtmlLite("<script>alert(1)</script>")).toBe("");
  });

  it("removes script in the middle of a document", () => {
    const out = sanitizeHtmlLite("<p>正常</p><script>bad()</script><p>後</p>");
    expect(out).toBe("<p>正常</p><p>後</p>");
    expect(out).not.toContain("bad()");
  });

  it("removes iframe, style, svg and their content", () => {
    expect(sanitizeHtmlLite('<iframe src="https://evil.com"></iframe>')).toBe("");
    expect(sanitizeHtmlLite("<style>body{display:none}</style>")).toBe("");
    expect(sanitizeHtmlLite("<svg onload=alert(1)>")).toBe("");
  });

  it("strips event handler attributes", () => {
    const out = sanitizeHtmlLite('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain("onerror");
    expect(out).toContain('src="x"');
  });

  it("strips onclick from links", () => {
    const out = sanitizeHtmlLite('<a href="https://ok.com" onclick="evil()">link</a>');
    expect(out).not.toContain("onclick");
    expect(out).toContain('href="https://ok.com"');
  });

  it("drops javascript: hrefs but keeps the link text", () => {
    const out = sanitizeHtmlLite('<a href="javascript:alert(1)">x</a>');
    expect(out).not.toContain("javascript:");
    expect(out).toContain(">x</a>");
  });

  it("drops data: hrefs", () => {
    const out = sanitizeHtmlLite('<a href="data:text/html,<script>alert(1)</script>">x</a>');
    expect(out).not.toContain("data:");
  });

  it("drops javascript: img srcs", () => {
    const out = sanitizeHtmlLite('<img src="javascript:alert(1)" alt="x">');
    expect(out).not.toContain("javascript:");
    expect(out).toContain('alt="x"');
  });

  it("rejects schemes obfuscated with control characters", () => {
    // Browsers ignore tabs/newlines inside a scheme, so "java\tscript:" runs.
    expect(sanitizeHtmlLite('<a href="java\tscript:alert(1)">x</a>')).not.toContain("script:");
    expect(sanitizeHtmlLite('<a href="java\nscript:alert(1)">x</a>')).not.toContain("script:");
    expect(sanitizeHtmlLite('<a href=" javascript:alert(1)">x</a>')).not.toContain("script:");
  });

  it("rejects uppercase and mixed-case schemes", () => {
    expect(sanitizeHtmlLite('<a href="JaVaScRiPt:alert(1)">x</a>')).not.toContain("cript:");
    expect(sanitizeHtmlLite('<a href="VBSCRIPT:msgbox(1)">x</a>')).not.toContain("BSCRIPT");
  });

  it("drops comments and doctypes", () => {
    expect(sanitizeHtmlLite("<!-- <script>alert(1)</script> -->")).toBe("");
    expect(sanitizeHtmlLite("<!DOCTYPE html>")).toBe("");
  });

  it("escapes a stray '<' that is not a tag", () => {
    expect(sanitizeHtmlLite("a < b")).toBe("a &lt; b");
  });

  it("escapes an unterminated tag rather than emitting it", () => {
    const out = sanitizeHtmlLite('<img src="x"');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;");
  });

  it("does not let a quote break out of an attribute", () => {
    const out = sanitizeHtmlLite('<a href="https://ok.com" title="x">t</a>');
    // title is not allow-listed, so it is dropped entirely.
    expect(out).not.toContain("title");
  });

  it("escapes quotes inside an allowed attribute value", () => {
    const out = sanitizeHtmlLite('<img src="https://ok.com/a.png" alt=\'say "hi"\'>');
    expect(out).toContain("&quot;");
    expect(out).not.toMatch(/alt="say "hi""/);
  });
});

describe("sanitizeHtmlLite: link hardening", () => {
  it("always adds target and rel to links", () => {
    const out = sanitizeHtmlLite('<a href="https://ok.com">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("overrides a caller-supplied target/rel", () => {
    const out = sanitizeHtmlLite('<a href="https://ok.com" target="_self" rel="opener">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).not.toContain("_self");
    expect(out).not.toContain('"opener"');
  });

  it("keeps relative and fragment URLs", () => {
    expect(sanitizeHtmlLite('<a href="/api/media/x.png">x</a>')).toContain('href="/api/media/x.png"');
    expect(sanitizeHtmlLite('<a href="#mention-a">x</a>')).toContain('href="#mention-a"');
  });

  it("keeps mailto", () => {
    expect(sanitizeHtmlLite('<a href="mailto:a@b.com">x</a>')).toContain('href="mailto:a@b.com"');
  });
});

describe("sanitizeHtmlLite: robustness", () => {
  it("handles empty and nullish input", () => {
    expect(sanitizeHtmlLite("")).toBe("");
    expect(sanitizeHtmlLite(undefined as unknown as string)).toBe("");
  });

  it("handles deeply nested allowed tags", () => {
    const out = sanitizeHtmlLite("<ul><li><strong><em>x</em></strong></li></ul>");
    expect(out).toBe("<ul><li><strong><em>x</em></strong></li></ul>");
  });

  it("handles unclosed allowed tags without throwing", () => {
    expect(() => sanitizeHtmlLite("<p><strong>x")).not.toThrow();
  });

  it("handles a large input without pathological slowdown", () => {
    const big = "<p>hello <strong>world</strong></p>".repeat(5000);
    const t0 = Date.now();
    sanitizeHtmlLite(big);
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
