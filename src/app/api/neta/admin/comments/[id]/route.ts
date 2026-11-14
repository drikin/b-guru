import { NextRequest, NextResponse } from "next/server";
import { deleteComment, netaAdminEmail } from "@/lib/neta-admin";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    await deleteComment(idParam((await params).id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-comment-delete");
  }
}
