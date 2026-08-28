import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { generateClubDefinition } from "@/lib/clubs";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** 部活の「AI判定定義」を さくらのAI Engine で自動生成（admin のみ）。
 *  body: { key?, name, category? } → { definition }
 *  ユーザー入力（key/name/category）はプロンプト文字列にのみ使われ、DB には触れない（SQL なし）。 */
export async function POST(req: Request) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  if (!isAdmin(email)) {
    return NextResponse.json({ error: "権限がありません" }, { status: 403, headers: NO_CACHE });
  }
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400, headers: NO_CACHE });
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "名前は必須です" }, { status: 400, headers: NO_CACHE });
  }
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  try {
    const definition = await generateClubDefinition({ key, name, category });
    return NextResponse.json({ definition }, { headers: NO_CACHE });
  } catch (e: any) {
    if ((e as Error)?.message === "NAME_REQUIRED") {
      return NextResponse.json({ error: "名前は必須です" }, { status: 400, headers: NO_CACHE });
    }
    console.error("clubs/catalog/generate-definition error:", e?.message);
    return NextResponse.json({ error: "判定定義の生成に失敗しました" }, { status: 500, headers: NO_CACHE });
  }
}
