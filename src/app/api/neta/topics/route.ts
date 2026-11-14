import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { getNetaViewer, requireNetaMember } from "@/lib/neta-auth";
import { createTopic, netaWritable } from "@/lib/neta-write";
import { CLOSED, fail, NEED_LOGIN, readBody } from "../_lib";

export const dynamic = "force-dynamic";

/** 今週にネタを投稿する: { url, title, description?, name? }。 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const viewer = await getNetaViewer();
    if (!viewer) return NEED_LOGIN();
    if (!netaWritable(viewer)) return CLOSED();
    const got = await requireNetaMember();
    if (!got) return NEED_LOGIN();
    const r = await createTopic(got.member, clientIp(req), body);
    return NextResponse.json({ ok: true, id: r.id }, { status: 201 });
  } catch (e) {
    return fail(e, "topic-create");
  }
}
