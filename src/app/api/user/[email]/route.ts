import { NextRequest, NextResponse } from "next/server";
import { getProfile, updateProfile, MAX_BIO } from "@/lib/profile";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

type Ctx = { params: Promise<{ email: string }> };

async function getEmail(params: Promise<{ email: string }>): Promise<string | null> {
  const { email } = await params;
  const dec = decodeURIComponent(email);
  return dec && dec.includes("@") ? dec.toLowerCase() : null;
}

// GET /api/user/[email] — profile header info + summary (own view, no-store)
export async function GET(_req: NextRequest, { params }: Ctx) {
  const me = await getSessionEmail();
  if (!me) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const email = await getEmail(params);
  if (!email) return NextResponse.json({ error: "不正なメールアドレス" }, { status: 400, headers: NO_CACHE });

  const profile = await getProfile(email);
  if (!profile)
    return NextResponse.json({ error: "ユーザーが見つかりません" }, { status: 404, headers: NO_CACHE });
  return NextResponse.json({ profile }, { headers: NO_CACHE });
}

// PUT /api/user/[email] — update profile (own email only, or admin)
export async function PUT(req: NextRequest, { params }: Ctx) {
  const me = await getSessionEmail();
  if (!me) return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });

  const email = await getEmail(params);
  if (!email) return NextResponse.json({ error: "不正なメールアドレス" }, { status: 400, headers: NO_CACHE });
  if (me.toLowerCase() !== email && !isAdmin(me))
    return NextResponse.json({ error: "このプロフィールは編集できません" }, { status: 403, headers: NO_CACHE });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON ボディが必要です" }, { status: 400, headers: NO_CACHE });
  }

  if (typeof body.bio === "string" && body.bio.length > MAX_BIO) {
    return NextResponse.json(
      { error: `自己紹介は${MAX_BIO}文字以内で指定してください` },
      { status: 400, headers: NO_CACHE }
    );
  }

  try {
    const profile = await updateProfile(email, {
      displayName: typeof body.display_name === "string" ? body.display_name : undefined,
      bio: typeof body.bio === "string" ? body.bio : undefined,
      headerImage: body.header_image === undefined ? undefined : body.header_image,
      links: body.links === undefined ? undefined : body.links,
    });
    return NextResponse.json({ profile }, { headers: NO_CACHE });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "プロフィールの更新に失敗しました";
    return NextResponse.json({ error: msg }, { status: 400, headers: NO_CACHE });
  }
}
