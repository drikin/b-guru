import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import { getPostPoll } from "@/lib/posts";
import { emitLive } from "@/lib/live";
import { validatePollInput, POLL_EDIT_WINDOW_MS } from "@/lib/poll";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store, no-cache, must-revalidate" } as const;

// PUT /api/poll/[postId]  — body { question, options: {id|null,label}[] }
// お題（質問/選択肢）を編集できるのは post author のみ・投稿後1時間以内。
// 投票が1票でも付いた選択肢は削除不可（400）。
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ postId: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です" }, { status: 401, headers: NO_STORE });
  }
  const postId = Number((await params).postId);
  if (!Number.isInteger(postId) || postId <= 0) {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }

  let body: { question?: unknown; options?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400, headers: NO_STORE });
  }

  // 投稿（author 権限）
  const postRow = await pool.query(`SELECT author_email FROM posts WHERE id = $1`, [postId]);
  if (postRow.rows.length === 0) {
    return NextResponse.json({ error: "投稿が見つかりません" }, { status: 404, headers: NO_STORE });
  }
  if (postRow.rows[0].author_email !== email) {
    return NextResponse.json({ error: "投稿者しかお題を編集できません" }, { status: 403, headers: NO_STORE });
  }

  // アンケート + 編集期限
  const pollRow = await pool.query(
    `SELECT question, created_at FROM post_polls WHERE post_id = $1`,
    [postId]
  );
  if (pollRow.rows.length === 0) {
    return NextResponse.json({ error: "投票が見つかりません" }, { status: 404, headers: NO_STORE });
  }
  const createdAt = pollRow.rows[0].created_at;
  if (Date.now() - new Date(createdAt).getTime() >= POLL_EDIT_WINDOW_MS) {
    return NextResponse.json(
      { error: "お題は投稿後1時間以内しか編集できません" },
      { status: 403, headers: NO_STORE }
    );
  }

  // 入力バリデーション
  const optionsIn = Array.isArray(body.options)
    ? (body.options as unknown[]).map((o) =>
        o && typeof o === "object" && "label" in (o as Record<string, unknown>)
          ? { id: (o as { id?: unknown }).id, label: (o as { label?: unknown }).label }
          : { id: null, label: o }
      )
    : [];
  const labels = optionsIn.map((o) => typeof o.label === "string" ? o.label : "");
  // 質問（投稿の本文）が省略された場合は既存値を保持。お題編集は回答のみを対象とし、
  // 本文（質問）の変更は通常の投稿編集で行う。
  const question = body.question != null && String(body.question).trim() !== ""
    ? String(body.question).trim()
    : pollRow.rows[0].question;
  const err = validatePollInput(question, labels);
  if (err) {
    return NextResponse.json({ error: err }, { status: 400, headers: NO_STORE });
  }
  const newOptions = optionsIn.map((o, i) => ({
    id: typeof o.id === "number" && o.id > 0 ? o.id : null,
    label: String(o.label).trim(),
    sort: i,
  }));

  // 現在の選択肢 + 票数。投票が付いた選択肢の削除は不可。
  const cur = await pool.query(
    `SELECT o.id, o.label,
       (SELECT count(*) FROM post_poll_votes v WHERE v.option_id = o.id) AS votes
     FROM post_poll_options o WHERE o.post_id = $1`,
    [postId]
  );
  const curMap = new Map<number, number>(cur.rows.map((r) => [Number(r.id), Number(r.votes) || 0]));
  const keepIds = new Set<number>(newOptions.filter((o) => o.id != null).map((o) => o.id as number));
  for (const r of cur.rows) {
    const id = Number(r.id);
    if (!keepIds.has(id) && (Number(r.votes) || 0) > 0) {
      return NextResponse.json(
        { error: "投票が付いた選択肢は削除できません" },
        { status: 400, headers: NO_STORE }
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE post_polls SET question = $1 WHERE post_id = $2`, [question, postId]);

    // 削除（0票の選択肢のみ）
    for (const r of cur.rows) {
      const id = Number(r.id);
      if (!keepIds.has(id)) {
        await client.query(`DELETE FROM post_poll_options WHERE post_id = $1 AND id = $2`, [postId, id]);
      }
    }
    // 更新/追加（並び順はペイロード順）
    const seen = new Set<number>();
    for (const o of newOptions) {
      if (o.id != null) {
        seen.add(o.id);
        await client.query(
          `UPDATE post_poll_options SET label = $1, sort_order = $2 WHERE post_id = $3 AND id = $4`,
          [o.label, o.sort, postId, o.id]
        );
      } else {
        await client.query(
          `INSERT INTO post_poll_options (post_id, label, sort_order) VALUES ($1, $2, $3)`,
          [postId, o.label, o.sort]
        );
      }
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  const poll = await getPostPoll(postId, email);
  try {
    emitLive({ type: "poll", action: "edit", postId, poll: poll! });
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true, poll }, { status: 200, headers: NO_STORE });
}

// POST（vote）は本ルートでは使わないが、Next.js は明示しない限りメソッド不在で 405。
export async function POST() {
  return NextResponse.json({ error: "Not Allowed" }, { status: 405, headers: NO_STORE });
}
