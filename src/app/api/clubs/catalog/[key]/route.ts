import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { getClub, updateClub } from "@/lib/club-store";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活を編集/削除（admin のみ）。[key] は部活キー。
 *  PATCH body: { name?, category?, definition?, active? }（active=false で削除=非表示化）
 *  DELETE: 削除（active=false）。 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }
  const { key } = await params;
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400, headers: NO_CACHE });
  }

  const fields: { name?: string; category?: string; definition?: string; active?: boolean } = {};
  if (typeof body.name === "string") fields.name = body.name;
  if (typeof body.category === "string") fields.category = body.category;
  if (typeof body.definition === "string") fields.definition = body.definition;
  if (typeof body.active === "boolean") fields.active = body.active;
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "更新内容がありません" }, { status: 400, headers: NO_CACHE });
  }

  const exists = await getClub(key);
  if (!exists) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_CACHE });
  }
  const club = await updateClub(key, fields);
  if (!club) {
    // manual 指定クラブを削除しようとした等
    return NextResponse.json({ error: "この部活は編集できません（システム予約）" }, { status: 400, headers: NO_CACHE });
  }
  return NextResponse.json({ club }, { headers: NO_CACHE });
}

/** 部活を削除＝非表示化（admin のみ）。ラベルは既存投稿に残る。 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ key: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }
  const { key } = await params;
  const exists = await getClub(key);
  if (!exists) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_CACHE });
  }
  const club = await updateClub(key, { active: false });
  if (!club) {
    return NextResponse.json({ error: "この部活は削除できません（システム予約）" }, { status: 400, headers: NO_CACHE });
  }
  return NextResponse.json({ club, deleted: true }, { headers: NO_CACHE });
}
