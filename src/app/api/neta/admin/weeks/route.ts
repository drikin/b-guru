import { NextRequest, NextResponse } from "next/server";
import { createWeek, netaAdminEmail } from "@/lib/neta-admin";
import { fail, NOT_ADMIN, readBody } from "../../_lib";

export const dynamic = "force-dynamic";

/** 新しい週を作る: { title, startDate, endDate, liveRecordingDate?, liveUrl? }（台本も前の週から作る）。 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const admin = await netaAdminEmail();
  if (!admin) return NOT_ADMIN();
  try {
    return NextResponse.json({ ok: true, ...(await createWeek(body, admin.split("@")[0])) }, { status: 201 });
  } catch (e) {
    return fail(e, "admin-week-create");
  }
}
