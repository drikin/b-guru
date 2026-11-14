/* GET /neta/app/enter — アプリの 📝 タブ（WebView）の入口。WebView の最初の読み込みに Authorization: Bearer <アプリの鍵>
 * を付けて開く。鍵が B-guru のアプリで出したもの（app_issued・post）なら、ネタ帳だけのログイン（neta_session、12 時間）を
 * 置いて /neta/app へ。外部の AI エージェントの鍵では入れない。B-guru の sessions は出さない。 */
import { NextRequest } from "next/server";
import { requireAppIssued, verifyAgentToken, AgentAuthError } from "@/lib/agent-auth";
import { clientIp } from "@/lib/client-ip";
import { startAppNetaSession } from "@/lib/neta-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } as const;

function page(status: number, text: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ネタ帳</title>
<style>body{font:15px/1.7 -apple-system,system-ui,sans-serif;margin:40px 20px;text-align:center;color:#555}@media(prefers-color-scheme:dark){body{background:#1a1b1e;color:#bbb}}</style>
<p>📝 ${text}</p>`;
  return new Response(html, { status, headers: { ...HEADERS, "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  try {
    const ctx = await verifyAgentToken(req.headers.get("authorization"), { ip: clientIp(req) });
    requireAppIssued(ctx);
    await startAppNetaSession(ctx.email, ctx.tokenId);
  } catch (e) {
    if (e instanceof AgentAuthError) return page(e.status, "ネタ帳を開けませんでした。アプリでログインし直してから、もう一度開いてください。");
    console.error("[neta-app] enter failed:", (e as Error)?.message);
    return page(500, "ネタ帳を開けませんでした。しばらくしてからもう一度お試しください。");
  }
  return new Response(null, { status: 303, headers: { ...HEADERS, Location: "/neta/app" } });
}
