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
    { error: "サーバーエラー", code: "unauthorized" },
    { status: 500, headers: NO_CACHE }
  );
}
