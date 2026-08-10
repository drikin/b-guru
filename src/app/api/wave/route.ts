import { NextRequest } from "next/server";
import { emitLive } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Minimum interval between waves from the same sender (anti-spam).
const MIN_INTERVAL_MS = 1500;
const lastWaveAt = new Map<string, number>();

// POST /api/wave — click an online member in the right sidebar to send them a
// "wave": a 👋 that floats up from the bottom-right of their screen (Insta-live
// hearts style). Broadcast over the existing SSE `liveBus` so all connected
// clients receive it; only the target (and the sender, for feedback) render it.
export async function POST(req: NextRequest) {
  const from = await getSessionEmail();
  if (!from) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: { to?: string } = {};
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const to = (body.to || "").trim();
  if (!to || to === from) {
    return new Response(JSON.stringify({ ok: false, error: "invalid target" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Per-sender rate limit to prevent spam.
  const now = Date.now();
  const last = lastWaveAt.get(from);
  if (last && now - last < MIN_INTERVAL_MS) {
    return new Response(JSON.stringify({ ok: false, error: "slow down" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  lastWaveAt.set(from, now);

  // Resolve the sender's display name (most recent known from posts).
  let name = from;
  try {
    const res = await pool.query(
      `SELECT author_name AS name FROM posts
       WHERE author_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [from]
    );
    if (res.rows[0]?.name) name = res.rows[0].name;
  } catch {
    /* non-fatal */
  }

  emitLive({ type: "wave", from: { email: from, name }, to });

  return new Response(JSON.stringify({ ok: true, name }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}