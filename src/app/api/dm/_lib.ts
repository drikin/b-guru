/* /api/dm/* 共通（Web・セッションのクッキー）: 本人を決めて、lib/dm-api.ts の結果を JSON で返す。 */
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import type { DmActor } from "@/lib/dm";
import type { DmApiResult } from "@/lib/dm-api";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

export async function webDmActor(): Promise<DmActor | null> {
  const email = await getSessionEmail();
  if (!email) return null;
  return { email, userId: await ensureUserId(email) };
}

export function dmJson(r: DmApiResult): Response {
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { ...NO_STORE, ...(r.headers ?? {}) } });
}

export const UNAUTHORIZED = (): Response =>
  new Response(JSON.stringify({ error: "ログインが必要です", code: "unauthorized" }), { status: 401, headers: NO_STORE });

export async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

/** 失敗は 500 にまとめる（中身は出さない）。 */
export async function guarded(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    console.error("[dm]", (e as Error)?.message);
    return new Response(JSON.stringify({ error: "サーバーエラー", code: "server_error" }), { status: 500, headers: NO_STORE });
  }
}
