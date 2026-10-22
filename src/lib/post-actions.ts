/* 投稿への操作（編集・削除・ピン・部活の付け替え・投票・お題の編集・お気に入り）の正本。
 *
 * Web の /api/posts/[id]・/api/posts/[id]/pin・/api/posts/[id]/club・/api/poll/*・/api/favorites と、
 * アプリ用の /api/agent/* の両方がここを呼ぶ（別実装にしない。docs/timeline-spec.md「操作」）。
 * 以前は検査（添付は 1 種類まで・投票の締切・選択肢の削除の可否など）が Web のルートの中に
 * 書いてあったので、そのままここへ移した。返す形 { status, body } は Web のルートの返事と同じ。
 * Web は body をそのまま返し、アプリ用 API は { error, code } に直して返す。 */
import { pool } from "./db";
import { deletePost, getPostPoll, setPostClub, togglePin, updatePost } from "./posts";
import { emitLive } from "./live";
import { ensureUserId } from "./user";
import { validatePollInput, POLL_EDIT_WINDOW_MS, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS } from "./poll";
import { addFavorite, favoriteAuthorEmailFromUserId, removeFavorite } from "./favorites";
import { LOCAL_IMAGE_RE } from "./publish";

export type ActionResult = { status: number; body: Record<string, unknown> };

const MEDIA_RE = /^\/api\/media\/[^/]+$/;

/** 返信か（ルート投稿でないか）。投稿が無ければ false（その後の lib が not_found を返す）。 */
async function isReply(postId: number): Promise<boolean> {
  const r = await pool.query(`SELECT parent_id FROM posts WHERE id = $1`, [postId]);
  return r.rows.length > 0 && r.rows[0].parent_id != null;
}

function postError(error: string | undefined): ActionResult {
  const status = error === "not_found" ? 404 : 403;
  return { status, body: { error } };
}

/** 自分の投稿の編集（本文・画像の差し替え・音声）。エピソード投稿は不可（updatePost）。
 *  images: 省略=そのまま、配列=差し替え（最大 5 枚）。audioUrl: 省略=そのまま、null/""=外す、文字列=付ける。
 *  動画は付け替えられない（Web と同じ）。localImagesOnly: アプリはサーバに上げた画像だけ。 */
export async function editOwnPost(
  email: string,
  postId: number,
  body: { text?: unknown; images?: unknown; audioUrl?: unknown },
  opts: { localImagesOnly?: boolean } = {}
): Promise<ActionResult> {
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const images = Array.isArray(body.images) ? (body.images as unknown[]).slice(0, 5) : undefined;
  if (images && images.some((u) => typeof u !== "string")) {
    return { status: 400, body: { error: "不正な画像URLです" } };
  }
  if (opts.localImagesOnly && images && (images as string[]).some((u) => !LOCAL_IMAGE_RE.test(u))) {
    // その投稿にもう付いている画像はそのまま残せる（Web から付けた画像・昔の投稿でも本文だけ直せるように）。
    // 新しく足す画像だけが「このサーバに上げたもの」でなければならない。
    const cur = await pool.query(`SELECT url FROM post_images WHERE post_id = $1`, [postId]);
    const attached = new Set<string>(cur.rows.map((r) => String(r.url)));
    if ((images as string[]).some((u) => !LOCAL_IMAGE_RE.test(u) && !attached.has(u))) {
      return { status: 400, body: { error: "不正な画像URLです" } };
    }
  }
  let audioUrl: string | null | undefined = undefined;
  if (body.audioUrl !== undefined) {
    if (body.audioUrl === null || body.audioUrl === "") {
      audioUrl = null;
    } else if (typeof body.audioUrl === "string" && MEDIA_RE.test(body.audioUrl)) {
      audioUrl = body.audioUrl;
    } else {
      return { status: 400, body: { error: "不正な音声URLです" } };
    }
  }

  if (!text && (!images || images.length === 0) && !audioUrl) {
    return { status: 400, body: { error: "テキスト・画像・音声のいずれかが必要です" } };
  }

  // 添付は 1 種類まで（投稿と同じ）。今回音声を付けるときだけ、動画付きの投稿を弾く。
  if (audioUrl) {
    const cur = await pool.query(`SELECT video_url FROM posts WHERE id = $1`, [postId]);
    if (cur.rows[0]?.video_url) {
      return { status: 400, body: { error: "動画と音声は同時に添付できません" } };
    }
  }

  const result = await updatePost(postId, email, { text, images: images as string[] | undefined, audioUrl });
  if (!result.ok) return postError(result.error);
  emitLive({ type: "post", postId, action: "update", authorId: await ensureUserId(email) });
  return { status: 200, body: { ok: true } };
}

/** 自分の投稿の削除。エピソード投稿は不可（deletePost）。 */
export async function deleteOwnPost(email: string, postId: number): Promise<ActionResult> {
  const result = await deletePost(postId, email);
  if (!result.ok) return postError(result.error);
  emitLive({ type: "post", postId, action: "delete", authorId: await ensureUserId(email) });
  return { status: 200, body: { ok: true } };
}

/** ピンの付け外し（自分の投稿・24 時間・1 人 1 件で新しいほうが勝つ）。 */
export async function togglePinAction(email: string, postId: number): Promise<ActionResult> {
  try {
    // ピンは自分のルート投稿だけ（Web の画面も返信にはピンを出さない）。
    if (await isReply(postId)) return { status: 400, body: { error: "返信はピンできません" } };
    const result = await togglePin(postId, email);
    if (!result.ok) return postError(result.error);
    emitLive({ type: "pin", postId, action: "toggle" });
    return { status: 200, body: { ok: true, pinned: result.pinned } };
  } catch (e) {
    console.error("pin error:", (e as Error)?.message);
    return { status: 500, body: { error: "ピンの更新に失敗しました" } };
  }
}

/** 部活ラベルの手動の付け替え（club=null で外す）。
 *  Web は投稿者か admin（setPostClub）。authorOnly: アプリ用 API は投稿者だけ（admin の操作は Web だけ）。 */
export async function setClubAction(
  email: string,
  postId: number,
  clubValue: unknown,
  opts: { authorOnly?: boolean } = {}
): Promise<ActionResult> {
  if (clubValue !== null && typeof clubValue !== "string") {
    return { status: 400, body: { error: "club は文字列または null のみ" } };
  }
  const club = clubValue as string | null;
  try {
    // 部活はルート投稿にだけ付く（返信は親に従う。Web の画面も返信には部活の札を出さない）。
    if (await isReply(postId)) {
      return { status: 400, body: { error: "返信の部活は変えられません（スレッドの部活はルート投稿で変えます）" } };
    }
    if (opts.authorOnly) {
      const r = await pool.query(`SELECT author_email FROM posts WHERE id = $1`, [postId]);
      if (r.rows.length === 0) return { status: 404, body: { error: "not_found" } };
      if (r.rows[0].author_email !== email) {
        return { status: 403, body: { error: "自分の投稿のみ編集できます" } };
      }
    }
    const result = await setPostClub(postId, email, club);
    if (!result.ok) {
      const status = result.error === "not_found" ? 404 : result.error === "不正な部活動です" ? 400 : 403;
      return { status, body: { error: result.error } };
    }
    return { status: 200, body: { ok: true, club } };
  } catch (e) {
    console.error("set club error:", (e as Error)?.message);
    return { status: 500, body: { error: "部活動ラベルの更新に失敗しました" } };
  }
}

/** 投票（1 人 1 票・締切前なら何度でも変えられる・締切後は 403）。 */
export async function votePoll(email: string, postId: number, optionId: number): Promise<ActionResult> {
  if (!(postId > 0) || !(optionId > 0)) {
    return { status: 400, body: { error: "不正な投票内容です" } };
  }
  const pollRow = await pool.query(
    `SELECT po.post_id, po.ends_at, po.post_id AS pid FROM post_polls po WHERE po.post_id = $1`,
    [postId]
  );
  if (pollRow.rows.length === 0) {
    return { status: 404, body: { error: "アンケートが見つかりません" } };
  }
  const endsAt = new Date(pollRow.rows[0].ends_at).getTime();
  if (Date.now() > endsAt) {
    return { status: 403, body: { error: "投票は終了しました" } };
  }
  const optRow = await pool.query(
    `SELECT id FROM post_poll_options WHERE post_id = $1 AND id = $2`,
    [postId, optionId]
  );
  if (optRow.rows.length === 0) {
    return { status: 400, body: { error: "選択肢が不正です" } };
  }
  await pool.query(
    `INSERT INTO post_poll_votes (post_id, option_id, email, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (post_id, email)
     DO UPDATE SET option_id = EXCLUDED.option_id, updated_at = now()`,
    [postId, optionId, email]
  );
  const poll = await getPostPoll(postId, email);
  if (!poll) {
    return { status: 404, body: { error: "アンケートが見つかりません" } };
  }
  try {
    emitLive({ type: "poll", action: "vote", postId, poll });
  } catch {
    /* ignore */
  }
  return { status: 200, body: { ok: true, poll } };
}

/** お題（回答）の編集。投稿者だけ・投稿後 1 時間以内・票の付いた選択肢は消せない。
 *  question を省くと今の質問のまま。options: [{ id|null, label }]（並びはこの順）。 */
export async function editPoll(
  email: string,
  postId: number,
  body: { question?: unknown; options?: unknown }
): Promise<ActionResult> {
  const postRow = await pool.query(`SELECT author_email FROM posts WHERE id = $1`, [postId]);
  if (postRow.rows.length === 0) {
    return { status: 404, body: { error: "投稿が見つかりません" } };
  }
  if (postRow.rows[0].author_email !== email) {
    return { status: 403, body: { error: "投稿者しかお題を編集できません" } };
  }
  const pollRow = await pool.query(`SELECT question, created_at FROM post_polls WHERE post_id = $1`, [postId]);
  if (pollRow.rows.length === 0) {
    return { status: 404, body: { error: "投票が見つかりません" } };
  }
  const createdAt = pollRow.rows[0].created_at;
  if (Date.now() - new Date(createdAt).getTime() >= POLL_EDIT_WINDOW_MS) {
    return { status: 403, body: { error: "お題は投稿後1時間以内しか編集できません" } };
  }

  const optionsIn = Array.isArray(body.options)
    ? (body.options as unknown[]).map((o) =>
        o && typeof o === "object" && "label" in (o as Record<string, unknown>)
          ? { id: (o as { id?: unknown }).id, label: (o as { label?: unknown }).label }
          : { id: null, label: o }
      )
    : [];
  const labels = optionsIn.map((o) => (typeof o.label === "string" ? o.label : ""));
  // 空の回答は弾く（validatePollInput は空を数えずに 3〜10 を見るので、空を混ぜると実際に残る数とずれる）。
  if (labels.some((l) => !l.trim())) return { status: 400, body: { error: "回答を入力してください" } };
  const question =
    body.question != null && String(body.question).trim() !== ""
      ? String(body.question).trim()
      : pollRow.rows[0].question;
  const err = validatePollInput(question, labels);
  if (err) return { status: 400, body: { error: err } };
  const newOptions = optionsIn.map((o, i) => ({
    id: typeof o.id === "number" && o.id > 0 ? o.id : null,
    label: String(o.label).trim(),
    sort: i,
  }));

  const cur = await pool.query(
    `SELECT o.id, o.label,
       (SELECT count(*) FROM post_poll_votes v WHERE v.option_id = o.id) AS votes
     FROM post_poll_options o WHERE o.post_id = $1`,
    [postId]
  );
  // id はこの投票の選択肢だけ・同じ id は 1 回だけ（他の投票の選択肢を書き換えたり、重複で数がずれたりしないように）。
  const curIds = new Set<number>(cur.rows.map((r) => Number(r.id)));
  const givenIds = newOptions.filter((o) => o.id != null).map((o) => o.id as number);
  if (givenIds.some((id) => !curIds.has(id))) return { status: 400, body: { error: "選択肢が不正です" } };
  if (new Set(givenIds).size !== givenIds.length) return { status: 400, body: { error: "選択肢が重複しています" } };
  // 実際に残る数（= 送られた選択肢の数）で 3〜10 を確かめる。
  if (newOptions.length < POLL_MIN_OPTIONS) return { status: 400, body: { error: `回答は${POLL_MIN_OPTIONS}個以上必要です` } };
  if (newOptions.length > POLL_MAX_OPTIONS) return { status: 400, body: { error: `回答は最大${POLL_MAX_OPTIONS}個までです` } };
  const keepIds = new Set<number>(givenIds);
  for (const r of cur.rows) {
    const id = Number(r.id);
    if (!keepIds.has(id) && (Number(r.votes) || 0) > 0) {
      return { status: 400, body: { error: "投票が付いた選択肢は削除できません" } };
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE post_polls SET question = $1 WHERE post_id = $2`, [question, postId]);
    // UNIQUE(post_id, sort_order) があるので、並べ替え・途中への追加で一時的に番号がぶつからないよう、
    // 残る選択肢の番号をいったん負の値へ逃がしてから書き直す（以前は 500 になっていた・QA 2026-10-22）。
    await client.query(`UPDATE post_poll_options SET sort_order = -1 - sort_order WHERE post_id = $1`, [postId]);
    for (const r of cur.rows) {
      const id = Number(r.id);
      if (!keepIds.has(id)) {
        await client.query(`DELETE FROM post_poll_options WHERE post_id = $1 AND id = $2`, [postId, id]);
      }
    }
    for (const o of newOptions) {
      if (o.id != null) {
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
  return { status: 200, body: { ok: true, poll } };
}

/** お気に入り（人）の付け外し。冪等で、最後の状態を返す。自分自身は不可。通知は出さない。 */
export async function setFavorite(email: string, userIdRaw: unknown, mode: "add" | "remove"): Promise<ActionResult> {
  const userId = typeof userIdRaw === "string" ? userIdRaw.trim() : "";
  if (!userId) return { status: 400, body: { error: "userId が必要です" } };
  try {
    const authorEmail = await favoriteAuthorEmailFromUserId(userId);
    if (!authorEmail) return { status: 404, body: { error: "ユーザーが見つかりません" } };
    if (authorEmail.trim().toLowerCase() === email.trim().toLowerCase()) {
      return { status: 400, body: { error: "自分自身はお気に入りにできません" } };
    }
    const favorited = mode === "add" ? await addFavorite(email, authorEmail) : await removeFavorite(email, authorEmail);
    return { status: 200, body: { favorited } };
  } catch (e) {
    console.error("favorites toggle error:", (e as Error)?.message);
    return { status: 500, body: { error: "処理に失敗しました" } };
  }
}
