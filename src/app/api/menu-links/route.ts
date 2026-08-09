import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { listMenuLinks, createMenuLink } from "@/lib/menulinks";

export const dynamic = "force-dynamic";

/** GET: list external-link menu bookmarks (any logged-in user can read). */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  }
  try {
    const links = await listMenuLinks();
    return NextResponse.json({ links });
  } catch (e) {
    console.error("listMenuLinks error", e);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500 });
  }
}

/** POST: create a new external-link menu bookmark (admin only). */
export async function POST(req: Request) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "認証が必要です" }, { status: 401 });
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403 });
  }
  let body: { label?: string; icon?: string; href?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }
  const link = await createMenuLink({
    label: body.label ?? "",
    icon: body.icon ?? "🔗",
    href: body.href ?? "",
  });
  if (!link) {
    return NextResponse.json({ error: "ラベルとURLは必須です" }, { status: 400 });
  }
  return NextResponse.json({ link }, { status: 201 });
}
