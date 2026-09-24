import { NextRequest, NextResponse } from "next/server";
import { findDuplicates, findNewsDuplicates } from "@/lib/duplicates";
import { getSessionEmail } from "@/lib/session";

export const dynamic = "force-dynamic";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

/**
 * POST /api/posts/duplicates — 投稿前の重複チェック。
 *
 * drikin 2026-09-25: 「似たような投稿があった時に警告したり、うまくそれを統合
 * したりするような、もうちょっと同じような情報をまとめ上げる仕組みを考えられ
 * ませんかね？」／「同じニュースで別のニュースサイトが報じているようなネタとか
 * でも、よく重複していることがあったりする」
 *
 * 投稿をブロックはしない。投稿者が「元の投稿に返信する」か「そのまま投稿する」
 * かを選べるようにするための情報を返すだけ。
 *
 * 本文は保存しない（読み取り専用の照会）。POST なのは本文が長くなりうるため
 * クエリ文字列を避けるためで、状態は変えない。
 *
 * ★ 2段階で返す（`phase` パラメータ）:
 *   - `phase=fast`（既定）: 動画ID / 正規化URL / 本文一致 / あいまい類似。
 *     すべて DB 内で完結するので即座に返る。
 *   - `phase=ai`: AI による「同じニュース」判定。外部サイトの取得（実測 9.4秒）
 *     と LLM 呼び出しが入るため遅い。
 *
 *   1回のリクエストで両方やると、警告が出るまで最大10秒待たされる。速い層を
 *   先に返して警告を即座に出し、AI の結果は後から足す方が体感が良い。
 */
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_CACHE });
  }

  let body: { text?: string; parentId?: number | null; phase?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_CACHE });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json({ duplicates: [] }, { headers: NO_CACHE });
  }

  const phase = body.phase === "ai" ? "ai" : "fast";

  try {
    const duplicates =
      phase === "ai"
        ? await findNewsDuplicates(text)
        : await findDuplicates({
            text,
            authorEmail: email,
            parentId: body.parentId ?? null,
          });
    return NextResponse.json({ duplicates, phase }, { headers: NO_CACHE });
  } catch (e) {
    // 重複チェックの失敗で投稿を止めてはいけない。空を返して投稿を続行させる。
    console.error("[duplicates] lookup failed", e);
    return NextResponse.json({ duplicates: [], phase }, { headers: NO_CACHE });
  }
}
