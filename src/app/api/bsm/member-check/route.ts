import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { findMemberByEmail, isPaidMember } from "@/lib/ghost";
import { gravatarUrl } from "@/lib/posts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// ---- In-process rate limit (per source IP) ----
// This endpoint is only called by nicenaito's app with a shared secret token.
// Allow a modest burst to absorb the member-facing load while capping abuse.
const REQ_LIMIT = 300;     // requests
const REQ_WINDOW = 60_000; // per millis window
const rate = new Map<string, { count: number; resetAt: number }>();
function allow(key: string): boolean {
  const now = Date.now();
  const cur = rate.get(key);
  if (!cur || now > cur.resetAt) {
    rate.set(key, { count: 1, resetAt: now + REQ_WINDOW });
    return true;
  }
  cur.count += 1;
  return cur.count <= REQ_LIMIT;
}

// Constant-time string comparison for the Bearer token.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function normalizeEmail(raw: string): string | null {
  const e = (raw || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null;
  if (e.length > 320) return null;
  return e;
}

// GET /api/bsm/member-check?email=<address>
// A narrow, least-privilege proxy for the BSM members: nicenaito's app sends
// an email + Bearer token, we look the member up via the Ghost Admin API and
// answer only "is this an active paid member" plus (for verified members only)
// their name and avatar. The broad Ghost Admin API key never leaves this server.
export async function GET(req: NextRequest) {
  const expected = process.env.BSM_CHECK_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "not configured" }, { status: 500, headers: NO_CACHE });
  }

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token || !safeEqual(token, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_CACHE });
  }

  const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  if (!allow(ip)) {
    return NextResponse.json({ error: "too many requests" }, { status: 429, headers: NO_CACHE });
  }

  const email = normalizeEmail(req.nextUrl.searchParams.get("email") || "");
  if (!email) {
    return NextResponse.json({ error: "email required" }, { status: 400, headers: NO_CACHE });
  }

  try {
    const member = await findMemberByEmail(email);
    if (!member || !isPaidMember(member)) {
      // Do not leak identity of non-members / non-paid — only isPaidMember:false.
      return NextResponse.json({ isPaidMember: false }, { headers: NO_CACHE });
    }
    const name = member.name && member.name.trim() ? member.name.trim() : null;
    const avatar =
      member.avatar_image && member.avatar_image.trim()
        ? member.avatar_image.trim()
        : gravatarUrl(email);
    return NextResponse.json({ isPaidMember: true, name, avatar }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("bsm/member-check:", e?.message);
    return NextResponse.json({ error: "upstream error" }, { status: 502, headers: NO_CACHE });
  }
}
