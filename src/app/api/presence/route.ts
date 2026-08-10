import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensurePresenceSweeper, getOnlineMembers } from "@/lib/presence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/presence — enriched list of currently-online paid members.
// Returns [{ email, name, avatar }] so the right-sidebar panel can render
// names and avatars without further lookups.
export async function GET(req: NextRequest) {
  ensurePresenceSweeper();
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ members: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  const members = await getOnlineMembers();
  return new Response(JSON.stringify({ members }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}