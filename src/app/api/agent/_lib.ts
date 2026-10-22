/* /api/agent/* 共通: 統一エラー JSON 化 + No-Cache ヘッダ。既存 /api/* は触らない。 */
import { NextResponse } from "next/server";
import { AgentAuthError } from "@/lib/agent-auth";

export const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

/** AgentAuthError → NextResponse、その他は 500。 */
export function agentErrorResponse(e: unknown): NextResponse {
  if (e instanceof AgentAuthError) {
    return NextResponse.json(e.body, { status: e.status, headers: NO_CACHE });
  }
  console.error("[agent]", (e as Error)?.message);
  return NextResponse.json(
    { error: "サーバーエラー", code: "server_error" },
    { status: 500, headers: NO_CACHE }
  );
}

/** withAgent の戻り値 → JSON Response（各ルート共通の締め）。 */
export function agentJson(out: { status: number; body: unknown; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE, ...(out.headers ?? {}) },
  });
}

/** 正の int32 ID か（PG integer 範囲外は 22003 になるので弾く）。 */
export function parsePositiveId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

/** lib/post-actions.ts の結果（Web のルートと同じ { status, body }）をアプリ用 API の形へ。
 *  成功は { apiVersion: 1, ...body }、失敗は { error, code }（文言は Web と同じ。"not_found" だけ日本語に）。 */
export function agentActionResult(r: { status: number; body: Record<string, unknown> }): {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
} {
  if (r.status < 300) return { status: r.status, body: { apiVersion: 1, ...r.body }, headers: {} };
  const raw = typeof r.body.error === "string" ? r.body.error : "処理に失敗しました";
  const code =
    r.status === 404 ? "not_found" : r.status === 403 ? "forbidden" : r.status >= 500 ? "server_error" : "invalid_request";
  return { status: r.status, body: { error: raw === "not_found" ? "投稿が見つかりません" : raw, code }, headers: {} };
}

/** JSON ボディを読む（読めなければ null）。 */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}

export const BAD_JSON = { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
