import { describe, it, expect } from "vitest";
import { genUserId, looksLikeEmail } from "../user";

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
