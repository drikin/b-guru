/* 📜 台本の書き込み（管理者＝出演者だけ）。
 *  PUT   { content, base }  保存（base は読んだときの updatedAt、なかったなら null。違えば 409 と今の版）
 *  POST  {}                 採用ネタで作り直した台本を返す（保存はしない）
 *  PATCH { check: n }       n 番目のチェック欄を切り替えて保存 */
import { NextRequest, NextResponse } from "next/server";
import { regenerateScript } from "@/lib/neta-admin";
import { saveScriptVersioned, scriptViewer, toggleScriptCheck } from "@/lib/neta-script-board";
import { fail, idParam, NOT_ADMIN, readBody } from "../../neta/_lib";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ weekId: string }> };

async function guard(req: NextRequest): Promise<{ body: Record<string, unknown>; email: string } | NextResponse> {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const v = await scriptViewer();
  if (!v?.admin) return NOT_ADMIN();
  return { body, email: v.email };
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const g = await guard(req);
  if (g instanceof NextResponse) return g;
  try {
    const script = await saveScriptVersioned(idParam((await params).weekId), g.body.content, g.body.base ?? null, g.email);
    return NextResponse.json({ script });
  } catch (e) {
    return fail(e, "script-save");
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const g = await guard(req);
  if (g instanceof NextResponse) return g;
  try {
    return NextResponse.json({ content: await regenerateScript(idParam((await params).weekId)) });
  } catch (e) {
    return fail(e, "script-regenerate");
  }
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const g = await guard(req);
  if (g instanceof NextResponse) return g;
  try {
    return NextResponse.json({ script: await toggleScriptCheck(idParam((await params).weekId), g.body.check, g.email) });
  } catch (e) {
    return fail(e, "script-check");
  }
}
