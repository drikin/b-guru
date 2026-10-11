/* GET /api/agent/clubs — 部活カタログ（既存 listClubs 再利用）。 */
import { NextRequest } from "next/server";
import { listClubs } from "@/lib/club-store";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/clubs", "read", async () => {
    const clubs = await listClubs({ activeOnly: true });
    return {
      status: 200,
      body: {
        apiVersion: 1,
        clubs: clubs.map((c) => ({
          key: c.key,
          name: c.name,
          category: c.category,
          definition: c.definition,
        })),
      },
      headers: {},
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
