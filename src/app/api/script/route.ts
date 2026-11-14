/* 📜 台本（有料会員だけ）: GET ?week=<id> — 週の一覧・選んだ週（なければ今週）の台本・管理者かどうか。 */
import { NextRequest, NextResponse } from "next/server";
import { readScript, scriptViewer, scriptWeeks } from "@/lib/neta-script-board";
import { fail, idParam } from "../neta/_lib";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  const v = await scriptViewer();
  if (!v) return NextResponse.json({ error: "BSM 会員限定です", code: "need_login" }, { status: 401, headers: NO_STORE });
  try {
    const weeks = await scriptWeeks();
    const asked = req.nextUrl.searchParams.get("week");
    const want = asked ? idParam(asked) : -1;
    const week = weeks.find((w) => w.id === want) ?? weeks.find((w) => w.isActive) ?? weeks[0] ?? null;
    const script = week ? await readScript(week.id) : null;
    return NextResponse.json({ admin: v.admin, weeks, weekId: week?.id ?? null, script }, { headers: NO_STORE });
  } catch (e) {
    return fail(e, "script-get");
  }
}
