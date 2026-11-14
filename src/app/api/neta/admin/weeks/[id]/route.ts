import { NextRequest, NextResponse } from "next/server";
import { deleteWeek, netaAdminEmail, setActiveWeek, updateWeek } from "@/lib/neta-admin";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** 週を直す: 項目を送る。{ active: true } で今週にする。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    const id = idParam((await params).id);
    const { active, ...fields } = body;
    await updateWeek(id, fields);
    if (active === true) await setActiveWeek(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-week-update");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    await deleteWeek(idParam((await params).id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-week-delete");
  }
}
