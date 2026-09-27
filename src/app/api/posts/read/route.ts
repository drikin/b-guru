import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { markPostsRead } from "@/lib/read-state-server";
import { MAX_READ_BATCH } from "@/lib/read-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

/**
 * レート制限（in-process）。既存の /api/posts/proofread と /api/ai/chat と
 * 同じパターン。
 *
 * ★ 必須。自動既読は「スクロールするだけで」発火するので、ユーザー操作起点の
 *   既存 API とは質的に異なる頻度で呼ばれる。nginx の client_max_body_size は
 *   85m、DB プールは max: 10、pm2 は fork_mode（単一プロセス）なので、
 *   無制限だと数リクエストでサイト全体が無応答になる。
 */
const hits = new Map<string, number[]>();
function rateLimit(email: string, limitPerWindow = 60, windowMs = 60_000): boolean {
  const now = Date.now();
  const arr = (hits.get(email) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= limitPerWindow) {
    hits.set(email, arr);
    return false;
  }
  arr.push(now);
  hits.set(email, arr);
  return true;
}

// POST /api/posts/read — 既読を記録する（単調・冪等）。
//
// ボディ: { ids: number[] }
//
// ★ 配列で受ける。自動既読は IntersectionObserver がカードごとに発火するので、
//   1 件ずつ POST するとスクロールだけで毎秒数十リクエストになる。クライアント側で
//   デバウンスしてまとめて送る前提。
//
// ★ 既読の取り消し API は作らない。既読は単調（一度読んだら戻らない）で、
//   従来の localStorage の Set も同じ意味論。
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }
  if (!rateLimit(email)) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: NO_STORE,
    });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: NO_STORE,
    });
  }

  const ids = (body as { ids?: unknown } | null)?.ids;
  if (!Array.isArray(ids)) {
    return new Response(JSON.stringify({ error: "ids must be an array" }), {
      status: 400,
      headers: NO_STORE,
    });
  }
  // ★ 上限を超えたら 400 で弾く。黙って切り詰めると、クライアントは
  //   全件送れたと誤認して残りを再送しない。
  if (ids.length > MAX_READ_BATCH) {
    return new Response(
      JSON.stringify({ error: "too_many_ids", max: MAX_READ_BATCH }),
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const marked = await markPostsRead(email, ids);
    return new Response(JSON.stringify({ ok: true, marked }), {
      status: 200,
      headers: NO_STORE,
    });
  } catch (e) {
    console.error("[posts/read] markPostsRead failed", e);
    return new Response(JSON.stringify({ error: "server_error" }), {
      status: 500,
      headers: NO_STORE,
    });
  }
}
