/* /api/offkai/* — 🍻 オフ会（Web、ログインのセッション）。道順と応答の形は lib/offkai-api.ts。
 * OFFKAI_ENABLED で出していない人には 404。 */
import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { albumZip, OffkaiError, offkaiEnabledFor } from "@/lib/offkai";
import { handleOffkai, notFound, type OffkaiHttpOut } from "@/lib/offkai-api";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

function respond(out: OffkaiHttpOut): Response {
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { "Content-Type": "application/json", ...NO_STORE } });
}

/** RFC 5987 の値（encodeURIComponent が残す ' ( ) * も符号化する）。 */
function rfc5987(v: string): string {
  return encodeURIComponent(v).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }): Promise<Response> {
  const email = await getSessionEmail();
  if (!email) return respond({ status: 401, body: { error: "ログインが必要です", code: "unauthorized" } });
  if (!offkaiEnabledFor(email)) return respond(notFound());
  const { path } = await ctx.params;
  const userId = await ensureUserId(email);
  // アルバムをまとめて保存（zip）。JSON ではないのでここで返す。参加した人と管理者だけ（lib/offkai.ts albumZip）。
  const [a, b, c] = path ?? [];
  if (req.method === "GET" && /^\d{1,9}$/.test(a ?? "") && b === "photos.zip" && !c) {
    // ほかのサイトから踏ませて読み込みと回数の枠を使わせない（同じサイトのボタンからだけ）。
    if (req.headers.get("sec-fetch-site") === "cross-site") return respond({ status: 403, body: { error: "このページからは保存できません", code: "forbidden" } });
    try {
      const z = await albumZip({ email, userId }, Number(a));
      return new Response(z.stream, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${z.asciiName}"; filename*=UTF-8''${rfc5987(z.filename)}`,
          ...NO_STORE,
        },
      });
    } catch (e) {
      if (e instanceof OffkaiError) return respond({ status: e.status, body: { error: e.message, code: e.code } });
      throw e;
    }
  }
  return respond(await handleOffkai(req, path ?? [], { email, userId }));
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
