/* POST /api/neta { url, title, description? } — Web から BS ネタ帳へ（ログイン必須）。lib/neta.ts。 */
import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { resolveDisplayNames } from "@/lib/display-name";
import { netaRateOk, normalizeNetaInput, submitToNeta } from "@/lib/neta";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const JSON_HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" } as const;

export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return new Response(JSON.stringify({ error: "ログインしてください", code: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  if (!netaRateOk(email)) return new Response(JSON.stringify({ error: "少し時間をおいてください", code: "rate_limited" }), { status: 429, headers: JSON_HEADERS });
  const input = normalizeNetaInput(await req.json().catch(() => null));
  if (!input.ok) return new Response(JSON.stringify({ error: input.error, code: "invalid" }), { status: 400, headers: JSON_HEADERS });
  const name = (await resolveDisplayNames([email])).get(email) || "B-guru 会員";
  const r = await submitToNeta(input.value, name);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: JSON_HEADERS });
}
