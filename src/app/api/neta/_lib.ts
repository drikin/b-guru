/* 📝 ネタ帳の API の共通部品。書き込みはすべて同じオリジンからだけ（よそのページから押させない）。 */
import { NextResponse, type NextRequest } from "next/server";
import { sameOrigin } from "@/app/api/auth/_lib";
import { LoginError } from "@/lib/login";
import { NetaError } from "@/lib/neta-write";

export async function readBody(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  if (!sameOrigin(req)) return NextResponse.json({ error: "オリジンが不正です" }, { status: 403 });
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
}

export function fail(e: unknown, where: string): NextResponse {
  if (e instanceof NetaError) return NextResponse.json({ error: e.message, code: e.code, ...e.extra }, { status: e.status });
  if (e instanceof LoginError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error(`[neta:${where}]`, (e as Error)?.message);
  return NextResponse.json({ error: "サーバーエラー" }, { status: 500 });
}

export const NEED_LOGIN = () => NextResponse.json({ error: "ログインしてください", code: "need_login" }, { status: 401 });
export const CLOSED = () =>
  NextResponse.json({ error: "いまは準備中です。投稿と聞きたいは neta.backspace.fm でどうぞ", code: "closed" }, { status: 503 });

export function idParam(raw: string): number {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
}

export const NOT_ADMIN = () => NextResponse.json({ error: "管理者だけの操作です" }, { status: 403 });
