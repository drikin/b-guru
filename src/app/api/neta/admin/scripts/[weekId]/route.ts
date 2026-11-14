import { NextRequest, NextResponse } from "next/server";
import { getScript, netaAdminEmail, regenerateScript, saveScript } from "@/lib/neta-admin";
import { fail, idParam, NOT_ADMIN, readBody } from "../../../_lib";

export const dynamic = "force-dynamic";

/** その週の台本（なければ script: null）。 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ weekId: string }> }) {
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    return NextResponse.json({ script: await getScript(idParam((await params).weekId)) });
  } catch (e) {
    return fail(e, "admin-script-get");
  }
}

/** { content } を保存する。 */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ weekId: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const admin = await netaAdminEmail();
  if (!admin) return NOT_ADMIN();
  try {
    await saveScript(idParam((await params).weekId), body.content, admin.split("@")[0]);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "admin-script-save");
  }
}

/** 採用ネタで作り直した台本を返す（保存はしない）。 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ weekId: string }> }) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  if (!(await netaAdminEmail())) return NOT_ADMIN();
  try {
    return NextResponse.json({ content: await regenerateScript(idParam((await params).weekId)) });
  } catch (e) {
    return fail(e, "admin-script-regenerate");
  }
}
