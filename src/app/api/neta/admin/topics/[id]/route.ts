import { NextRequest, NextResponse } from "next/server";
import { deleteTopic, netaAdminEmail, setTopicStatus, type NetaTopicStatus } from "@/lib/neta-admin";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** { status: "pending"|"featured"|"rejected" } — ふつう・採用（番組で話した）・不採用（一覧から外す）。
 * 前からの { featured: true|false } も受ける（採用にする・ふつうに戻す）。 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    const status = typeof body.status === "string" ? body.status : body.featured === true ? "featured" : "pending";
    await setTopicStatus(idParam((await params).id), status as NetaTopicStatus); // 知らない値は setTopicStatus が断る
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
