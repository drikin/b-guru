import { describe, it, expect } from "vitest";
import {
  validateLinks,
  validateHeaderImage,
  MAX_BIO,
  MAX_LINKS,
  MAX_LINK_LABEL,
} from "../profile";

describe("validateLinks", () => {
  it("accepts valid http(s) links and strips empties", () => {
    const r = validateLinks([
      { label: "X", href: "https://x.com/foo" },
      { label: "自前", href: "http://example.com" },
      { label: "", href: "" },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.links).toEqual([
        { label: "X", href: "https://x.com/foo" },
        { label: "自前", href: "http://example.com" },
      ]);
    }
  });

  it("accepts /api/media/ uploaded-image paths (banner images)", () => {
    const r = validateLinks([{ label: "動画", href: "/api/media/abc123" }]);
    expect(r.ok).toBe(true);
  });

  it("rejects non-http and non-media hrefs", () => {
    const r = validateLinks([{ label: "bad", href: "javascript:alert(1)" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects > MAX_LINKS entries", () => {
    const many = Array.from({ length: MAX_LINKS + 1 }, (_, i) => ({ label: `l${i}`, href: `https://x.com/${i}` }));
    const r = validateLinks(many);
    expect(r.ok).toBe(false);
  });

  it("rejects an over-long label", () => {
    const r = validateLinks([{ label: "あ".repeat(MAX_LINK_LABEL + 1), href: "https://x.com" }]);
    expect(r.ok).toBe(false);
  });

  it("rejects a non-array input", () => {
    expect(validateLinks("nope").ok).toBe(false);
    expect(validateLinks(null).ok).toBe(false);
  });
});

describe("validateHeaderImage", () => {
  const unwrap = (v: unknown) => {
    const r = validateHeaderImage(v);
    return r.ok ? r.value : null;
  };

  it("accepts null / empty → null (no banner)", () => {
    expect(unwrap(null)).toBeNull();
    expect(unwrap("")).toBeNull();
  });

  it("accepts /api/media/ paths (uploaded images)", () => {
    expect(unwrap("/api/media/banner-123.png")).toBe("/api/media/banner-123.png");
  });

  it("accepts https URLs", () => {
    expect(unwrap("https://cdn.example.com/banner.jpg")).toBe("https://cdn.example.com/banner.jpg");
  });

  it("rejects non-https / media-relative junk", () => {
    expect(validateHeaderImage("javascript:alert(1)").ok).toBe(false);
    expect(validateHeaderImage("/etc/passwd").ok).toBe(false);
    expect(validateHeaderImage(123).ok).toBe(false);
  });
});

// Sanity anchor so the constant is referenced (guards accidental removal).
describe("constants", () => {
  it("exposes limits used by the API layer", () => {
    expect(typeof MAX_BIO).toBe("number");
    expect(typeof MAX_LINKS).toBe("number");
    expect(typeof MAX_LINK_LABEL).toBe("number");
  });
});
