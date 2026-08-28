import { NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import {
  listClubs,
  createClub,
  type ClubCatalogRow,
} from "@/lib/club-store";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/** active な部活をカテゴリごとにまとめる（seed 順 = sort 順を保つ）。 */
function groupCategories(rows: ClubCatalogRow[]): { name: string; keys: string[] }[] {
  const order: string[] = [];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    if (!map.has(r.category)) {
      map.set(r.category, []);
      order.push(r.category);
    }
    map.get(r.category)!.push(r.key);
  }
  return order.map((name) => ({ name, keys: map.get(name)! }));
}

/** 部活カタログ取得（要ログイン）。左SB/部活ラベル/AI分類対象の現在の定義を返す。
 *  clubs は active/inactive を問わず全件（削除済みクラブの既存ラベルを表示できるよう）。
 *  categories は active のみで構成。 */
export async function GET() {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }
  try {
    const clubs = await listClubs({ activeOnly: false });
    const active = clubs.filter((c) => c.active);
    return NextResponse.json(
      { clubs, categories: groupCategories(active) },
      { headers: NO_CACHE }
    );
  } catch (e: any) {
    console.error("clubs/catalog GET error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}

/** 部活を追加（admin のみ）。body: { key, name, category, definition? } */
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
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const definition = typeof body.definition === "string" ? body.definition.trim() : "";
  if (!key || !name) {
    return NextResponse.json({ error: "key と name は必須です" }, { status: 400, headers: NO_CACHE });
  }
  try {
    const club = await createClub({ key, name, category, definition });
    if (!club) {
      return NextResponse.json({ error: "そのキーは既に使われています" }, { status: 409, headers: NO_CACHE });
    }
    return NextResponse.json({ club }, { status: 201, headers: NO_CACHE });
  } catch (e: any) {
    const msg = (e as Error)?.message;
    if (msg === "INVALID_KEY") {
      return NextResponse.json({ error: "キーは小文字英数字・「-」「_」の40文字以内にしてください" }, { status: 400, headers: NO_CACHE });
    }
    console.error("clubs/catalog POST error:", e?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500, headers: NO_CACHE });
  }
}
