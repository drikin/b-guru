/* POST /api/voice/diag — Web の音声の様子を pm2 のログに残す（ドリキン 2026-11-08「ブラウザ版で音声に繋がらない」。
 * オンラインオフ会でみんなで直しながら原因を探すため）。メールは書かない（user id だけ）。1 人 1 分 40 件まで。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const hits = new Map<string, number[]>();

export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return new NextResponse(null, { status: 204 });
  const now = Date.now();
  const list = (hits.get(email) ?? []).filter((t) => now - t < 60_000);
  if (list.length >= 40) return new NextResponse(null, { status: 204 });
  list.push(now);
  hits.set(email, list);
  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    /* ignore */
  }
  const text = JSON.stringify(body ?? {}).replace(/[\r\n]/g, " ").slice(0, 600);
  const ua = (req.headers.get("user-agent") ?? "").replace(/[\r\n]/g, " ").slice(0, 120);
  console.log(`[voice-diag] uid=${await ensureUserId(email)} ${text} ua=${ua}`);
  return new NextResponse(null, { status: 204 });
}
