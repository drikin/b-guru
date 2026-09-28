import { describe, it, expect, vi, beforeEach } from "vitest";

// resolveEmailSegment hits the DB for the opaque-id path; the email path must
// NOT touch it. Mock the pool so the test stays hermetic and can assert that.
const query = vi.fn();
vi.mock("../db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { genUserId, looksLikeEmail, resolveEmailSegment } from "../user";

beforeEach(() => {
  query.mockReset();
});

describe("genUserId", () => {
  it("produces a URL-safe opaque id of the expected length", () => {
    const a = genUserId();
    const b = genUserId();
    // length
    expect(a.length).toBe(12);
    // URL-safe alphabet only (no email chars, no separators that break #/user/)
    expect(a).toMatch(/^[A-Za-z0-9]{12}$/);
    // different values for different calls
    expect(a).not.toBe(b);
    // never contains '@' (no email leakage)
    expect(a).not.toContain("@");
  });

  it("respects an injectable rand for deterministic tests", () => {
    // rand always 0 → first alphabet char repeated
    expect(genUserId(() => 0)).toBe("AAAAAAAAAAAA");
    // rand ~ 0.9999 → last char (alphabet length 62)
    expect(genUserId(() => 0.999)).toBe("999999999999");
  });
});

describe("looksLikeEmail", () => {
  it("detects emails vs opaque user_ids", () => {
    expect(looksLikeEmail("drikin@gmail.com")).toBe(true);
    expect(looksLikeEmail("AbCdefGHijKl")).toBe(false);
    expect(looksLikeEmail("")).toBe(false);
  });
});

describe("resolveEmailSegment", () => {
  it("resolves an opaque user_id through the users table", async () => {
    query.mockResolvedValueOnce({ rows: [{ email: "drikin@gmail.com" }] });
    await expect(resolveEmailSegment("AbCdefGHijKl")).resolves.toBe("drikin@gmail.com");
    // Looked up by user_id, not by email.
    expect(query.mock.calls[0][1]).toEqual(["AbCdefGHijKl"]);
  });

  it("returns null for an unknown opaque user_id", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(resolveEmailSegment("NoSuchUser12")).resolves.toBeNull();
  });

  it("treats a legacy email segment as an email WITHOUT hitting the DB", async () => {
    await expect(resolveEmailSegment("Drikin@Gmail.com")).resolves.toBe("drikin@gmail.com");
    expect(query).not.toHaveBeenCalled();
  });

  it("decodes a percent-encoded legacy email segment", async () => {
    await expect(resolveEmailSegment("drikin%40gmail.com")).resolves.toBe("drikin@gmail.com");
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null for an empty or whitespace-only segment", async () => {
    await expect(resolveEmailSegment("")).resolves.toBeNull();
    await expect(resolveEmailSegment("   ")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null for malformed percent-encoding instead of throwing", async () => {
    await expect(resolveEmailSegment("%")).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });
});
