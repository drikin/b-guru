import { NextRequest, NextResponse } from "next/server";
import { netaAdminEmail, suggestTitles } from "@/lib/neta-admin";
import { hitLimit } from "@/lib/login";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** エピソードのタイトル案（さくらの AI）。1 人 1 時間 30 回まで。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ weekId: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const admin = await netaAdminEmail();
  if (!admin) return NOT_ADMIN();
  try {
    if (!(await hitLimit(`neta-titles:${admin}`, { limit: 30, window: "1 hour" }))) {
      return NextResponse.json({ error: "回数が多すぎます。少し待ってください" }, { status: 429 });
    }
    const suggestions = await suggestTitles(idParam((await params).weekId));
    if (suggestions.length === 0) return NextResponse.json({ error: "タイトル案を作れませんでした。もう一度どうぞ" }, { status: 502 });
    return NextResponse.json({ suggestions });
  } catch (e) {
    return fail(e, "admin-titles");
  }
}
