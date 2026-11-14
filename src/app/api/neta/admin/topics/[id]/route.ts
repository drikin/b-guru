import { NextRequest, NextResponse } from "next/server";
import { deleteTopic, netaAdminEmail, setTopicFeatured } from "@/lib/neta-admin";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** { featured: true|false } — 採用（番組で話した）にする・戻す。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    await setTopicFeatured(idParam((await params).id), body.featured === true);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-topic-featured");
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    await deleteTopic(idParam((await params).id));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-topic-delete");
  }
}
