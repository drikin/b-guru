import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { updateMenuLink, deleteMenuLink } from "@/lib/menulinks";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** PATCH: update an external-link menu bookmark (admin only). */
export async function PATCH(req: Request, ctx: Ctx) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "不正なIDです" }, { status: 400 });
  }
  let body: { label?: string; icon?: string; href?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  const link = await updateMenuLink(numId, {
    label: body.label ?? "",
    icon: body.icon ?? "🔗",
    href: body.href ?? "",
  });
  if (!link) {
    return NextResponse.json({ error: "ラベルとURLは必須です、または見つかりません" }, { status: 400 });
  }
  return NextResponse.json({ link });
}

/** DELETE: remove an external-link menu bookmark (admin only). */
export async function DELETE(_req: Request, ctx: Ctx) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) {
    return NextResponse.json({ error: "不正なIDです" }, { status: 400 });
  }
  const ok = await deleteMenuLink(numId);
  if (!ok) {
    return NextResponse.json({ error: "見つかりません" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
