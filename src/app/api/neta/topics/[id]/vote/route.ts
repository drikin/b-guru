import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { getNetaViewer, requireNetaMember } from "@/lib/neta-auth";
import { netaWritable, setVote } from "@/lib/neta-write";
import { CLOSED, fail, idParam, NEED_LOGIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** 聞きたい: { on: true } で入れる、{ on: false } で外す。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const viewer = await getNetaViewer();
    if (!viewer) return NEED_LOGIN();
    if (!netaWritable(viewer)) return CLOSED();
    const got = await requireNetaMember();
    if (!got) return NEED_LOGIN();
    const r = await setVote(got.member, idParam((await params).id), body.on !== false, clientIp(req));
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return fail(e, "vote");
  }
}
