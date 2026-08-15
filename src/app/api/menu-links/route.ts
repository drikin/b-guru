import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { listMenuLinks, createMenuLink } from "@/lib/menulinks";

export const dynamic = "force-dynamic";

// Never cache menu-links responses: the GET list is re-read right after every
// create/update/delete so the sidebar must always reflect the latest state.
const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** GET: list external-link menu bookmarks (any logged-in user can read). */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "認証が必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const links = await listMenuLinks();
    return NextResponse.json({ links }, { headers: NO_CACHE });
  } catch (e) {
    console.error("listMenuLinks error", e);
    return NextResponse.json({ error: "取得に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}

/** POST: create a new external-link menu bookmark (admin only). */
export async function POST(req: Request) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "認証が必要です" }, { status: 401, headers: NO_CACHE });
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }
  let body: { label?: string; icon?: string; href?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_CACHE });
  }
  const link = await createMenuLink({
    label: body.label ?? "",
    icon: body.icon ?? "🔗",
    href: body.href ?? "",
  });
  if (!link) {
    return NextResponse.json({ error: "ラベルとURLは必須です" }, { status: 400, headers: NO_CACHE });
  }
  return NextResponse.json({ link }, { status: 201, headers: NO_CACHE });
}
