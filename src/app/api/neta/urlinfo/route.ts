/* GET /api/neta/urlinfo?url= — 📝 ネタ帳の投稿欄・B-guru の「ネタ帳に送る」で、URL から題名と一言を補完する
 * （中身は lib/neta-urlinfo.ts）。ログインしていなくても使える（ブックマークレットから開いた投稿欄など）。
 * 1 分 20 回まで（ログインしていれば人ごと、していなければ IP ごと）。 */
import { NextResponse, type NextRequest } from "next/server";
import { getNetaViewer } from "@/lib/neta-auth";
import { clientIp } from "@/lib/client-ip";
import { fetchNetaUrlInfo, publicHttpUrl, urlInfoRateOk } from "@/lib/neta-urlinfo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("url") ?? "";
  if (!publicHttpUrl(raw)) return NextResponse.json({ error: "URL が正しくありません", code: "invalid" }, { status: 400 });
  const v = await getNetaViewer().catch(() => null);
  const key = v ? `v:${v.email}` : `ip:${clientIp(req) ?? "?"}`;
  if (!urlInfoRateOk(key)) return NextResponse.json({ error: "回数が多すぎます。しばらくしてからどうぞ", code: "rate_limited" }, { status: 429 });
  const info = await fetchNetaUrlInfo(raw);
  return NextResponse.json(info, { headers: { "Cache-Control": "no-store" } });
}
