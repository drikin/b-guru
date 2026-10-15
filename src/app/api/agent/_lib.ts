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
