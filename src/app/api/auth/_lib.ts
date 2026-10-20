import type { NextRequest } from "next/server";

/** Same-origin check for the cookie-setting auth routes (same rule as
 * /api/agent/token): a cross-site page cannot submit a code or link token on
 * the visitor's behalf. */
export function sameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === req.headers.get("host");
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}
