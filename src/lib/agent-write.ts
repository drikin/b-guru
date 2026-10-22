/* エージェント書き込み共通 lib（フェーズ2）。
 * /api/agent/* の書き込みルートと MCP ツールの両方から呼ばれる正本。
 * 判断ロジックは置かない: 既存 lib（posts / reactions / read-state-server /
 * bookmarks / notifications / club-store）を 1:1 で包むだけ。
 * 原則: 自分名義のみ（ctx.email を使う・body の author 系は信用しない）、
 * 投稿には via: "agent" を自動付与（UI にエージェント由来マークを出せる）。 */
import { createPost, mapRow, POST_SELECT, updatePost, deletePost } from "./posts";
import { pool } from "./db";
import { toggleReaction } from "./reactions";
import { markPostsRead } from "./read-state-server";
import { addBookmark, removeBookmark, isBookmarked } from "./bookmarks";
import { createNotification } from "./notifications";
import { getProfile } from "./profile";
import { emitLive } from "./live";
import { isActiveClubKey } from "./club-store";
import { findMemberByEmail } from "./ghost";
import type { AgentContext } from "./agent-auth";
import type { FeedPost } from "./posts";
import { agentPostDto } from "./agent-post-dto";

/** 投稿本文の上限（UI 投稿と同水準の暴走ガード）。 */
export const AGENT_POST_MAX_TEXT = 5000;

/** 投稿の形はアプリ用 API と同じ 1 つ（agent-post-dto.ts が正本）。名前は既存の呼び出しのために残す。 */
export const asAgentPostDto = (p: FeedPost) => agentPostDto(p);

/** 投稿者表示名: user_profiles → Ghost の順（/api/publish と同一規則）。 */
async function resolveAuthorName(email: string): Promise<string | null> {
  try {
    const profile = await getProfile(email);
    if (profile) return profile.name;
  } catch {}
  try {
    const member = await findMemberByEmail(email);
    return member?.name || null;
  } catch {}
  return null;
}

/** エージェント投稿（返信は parent_id 指定）。via: "agent" を自動付与する。 */
export async function agentCreatePost(
  ctx: AgentContext,
  input: { text: string; parent_id?: number | null; club?: string | null }
): Promise<FeedPost> {
  const text = String(input.text ?? "").trim();
  if (!text) {
    const e = new Error("text が必要です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  if (text.length > AGENT_POST_MAX_TEXT) {
    const e = new Error(`本文は ${AGENT_POST_MAX_TEXT} 文字までです`) as Error & {
      code: string;
      status: number;
    };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const rawParentId =
    Number.isInteger(input.parent_id) && (input.parent_id as number) > 0
      ? (input.parent_id as number)
      : null;

  // parent_id はルート投稿でも返信でも渡してよい。返信を指すときはそのルート
  // 投稿に正規化する（UI は常に 1 階層フラットのため、返信の返信= 孫は
  // スレッド一覧に現れず孤児になる。posts.ts / feed.ts に共有の root 解決
  // ロジックが無いため、ここで parent_id を辿るのが正本）。
  // 返信でない post（parent_id IS NULL）しか親として受理しないので、
  // 存在しない ID は invalid_request（孤児投稿を防ぐ）。
  // 深さ上限 64 を超えた / 循環している場合も invalid_request（フォール
  // スルーしてルート投稿を作ると事故になるため）。author_email は club の
  // 権限判定（下記）で使うので同時に取る。
  let parentId: number | null = null;
  let rootAuthorEmail: string | null = null;
  if (rawParentId !== null) {
    let cursor: number | null = rawParentId;
    for (let depth = 0; cursor !== null && depth < 64; depth++) {
      const r: { rows: { parent_id: number | null; author_email: string | null }[] } =
        await pool.query(`SELECT parent_id, author_email FROM posts WHERE id = $1 LIMIT 1`, [
          cursor,
        ]);
      const row: { parent_id: number | null; author_email: string | null } | undefined =
        r.rows[0];
      if (!row) {
        const e = new Error(`返信先の投稿が見つかりません: ${rawParentId}`) as Error & {
          code: string;
          status: number;
        };
        e.code = "invalid_request";
        e.status = 400;
        throw e;
      }
      if (row.parent_id === null) {
        parentId = cursor;
        rootAuthorEmail = row.author_email;
        break;
      }
      cursor = row.parent_id;
    }
    if (parentId === null) {
      const e = new Error(
        `返信先のスレッドを辿れませんでした（深さ上限超過または循環）: ${rawParentId}`
      ) as Error & { code: string; status: number };
      e.code = "invalid_request";
      e.status = 400;
      throw e;
    }
  }

  const authorName = await resolveAuthorName(ctx.email);
  const post = await createPost({
    authorEmail: ctx.email,
    authorName,
    text,
    parentId,
    via: "agent",
  });

  // 部活ラベルの明示指定（任意）。指定があれば必ず検証し、無効キーは
  //   invalid_request を返す（黙って捨てると agent 側で検知できない）。
  // 返信（parent_id あり）でも適用する: 返信の club は親スレッドのルート投稿の
  //   club を上書きする（= スレッドの部活ラベルの付け替え）。返信自体は UI の
  //   タイムラインには出ないため、返信の club を黙って捨てると agent から
  //   見えないバグになった（id 8113/8115/8116/8130 実測）。無指定なら
  //   触らない（自動分類・親スレッドの既存ラベルを壊さない）。
  // 権限: UI の setPostClub（posts.ts / PATCH /api/posts/[id]/club）と同一の
  //   「投稿者本人のみ」に合わせる。返信で club を渡してもルート投稿の投稿者
  //   が自分でなければ黙って無視する（返信自体は成立させる。4xx で返すと
  //   返信本文が失われる。無効キーのみ invalid_request）。他人が club_manual
  //   = TRUE で付けたラベルを agent が勝手に付け替えないためのガード。
  const club = typeof input.club === "string" ? input.club.trim() : "";
  if (club && !(await isActiveClubKey(club))) {
    const e = new Error(`無効な部活キーです: ${club}`) as Error & {
      code: string;
      status: number;
    };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  let relabeledPostId: number | null = null;
  if (club) {
    const target = parentId ?? post.id;
    // 返信経路ではルート投稿の投稿者本人（rootAuthorEmail === ctx.email）のとき
    // のみ UPDATE する → 他人の club_manual = TRUE ラベルは絶対に上書きしない
    // （UI の setPostClub と同じ権限。本人の投稿なら手動ラベルも付け替え可）。
    if (parentId === null || rootAuthorEmail === ctx.email) {
      await pool.query(
        `UPDATE posts SET club = $2, club_manual = TRUE, classified_at = now() WHERE id = $1`,
        [target, club]
      );
      relabeledPostId = target;
    }
  }

  // 返信なら親投稿者へ通知（/api/publish と同一・自己返信は除外）。
  if (parentId) {
    try {
      const parent = await pool.query(
        `SELECT author_email FROM posts WHERE id = $1`,
        [parentId]
      );
      const parentAuthor = parent.rows[0]?.author_email;
      if (parentAuthor && parentAuthor !== ctx.email) {
        await createNotification({
          userEmail: parentAuthor,
          type: "reply",
          actorEmail: ctx.email,
          actorName: authorName,
          postId: parentId,
          replyId: post.id,
          text: text.length > 60 ? text.slice(0, 57) + "…" : text,
        });
      }
    } catch {
      /* 通知はベストエフォート */
    }
  }

  // club を付け替えたら setPostClub（posts.ts / PATCH /api/posts/[id]/club）と
  // 同じ club イベントを SSE へ流す（Live クライアントのラベル表示を即時更新）。
  if (relabeledPostId !== null) {
    try {
      emitLive({ type: "club", postId: relabeledPostId, club });
    } catch {
      /* ignore */
    }
  }

  try {
    emitLive({
      type: "post",
      postId: post.id,
      action: "create",
      authorId: ctx.userId,
    });
  } catch {
    /* ignore */
  }
  return post;
}

/** 投稿本文編集（自分の投稿のみ・text のみ・メディアは触らない）。
 *  既存 updatePost（posts.ts・UI と同一正本）を再利用。権限判定は lib 側
 *  （not_found / 自分以外）に任せ、HTTP ステータスへ正規化する。 */
export async function agentUpdatePost(
  ctx: AgentContext,
  postId: number,
  input: { text: string }
): Promise<{ updated: true }> {
  if (!Number.isInteger(postId) || postId <= 0) {
    const e = new Error("post_id が不正です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const text = String(input.text ?? "").trim();
  if (!text) {
    const e = new Error("text が必要です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  if (text.length > AGENT_POST_MAX_TEXT) {
    const e = new Error(`本文は ${AGENT_POST_MAX_TEXT} 文字までです`) as Error & {
      code: string;
      status: number;
    };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const r = await updatePost(postId, ctx.email, { text });
  if (!r.ok) {
    // not_found（存在しない）/ 自分以外の投稿 / エピソード投稿 → 404 or 403
    const status = r.error === "not_found" ? 404 : 403;
    const code = r.error === "not_found" ? "not_found" : "forbidden";
    const e = new Error(
      r.error === "not_found" ? "投稿が見つかりません" : r.error || "編集できません"
    ) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    throw e;
  }
  try {
    emitLive({ type: "post", postId, action: "update", authorId: ctx.userId });
  } catch {
    /* ignore */
  }
  return { updated: true };
}

/** 投稿削除（自分の投稿のみ）。既存 deletePost（posts.ts・UI と同一正本）を再利用。 */
export async function agentDeletePost(
  ctx: AgentContext,
  postId: number
): Promise<{ deleted: true }> {
  if (!Number.isInteger(postId) || postId <= 0) {
    const e = new Error("post_id が不正です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const r = await deletePost(postId, ctx.email);
  if (!r.ok) {
    const status = r.error === "not_found" ? 404 : 403;
    const code = r.error === "not_found" ? "not_found" : "forbidden";
    const e = new Error(
      r.error === "not_found" ? "投稿が見つかりません" : r.error || "削除できません"
    ) as Error & { code: string; status: number };
    e.code = code;
    e.status = status;
    throw e;
  }
  try {
    emitLive({ type: "post", postId, action: "delete", authorId: ctx.userId });
  } catch {
    /* ignore */
  }
  return { deleted: true };
}

/** リアクショントグル（投稿のみ・chat は対象外）。 */
export async function agentToggleReaction(
  ctx: AgentContext,
  postId: number,
  emoji: string
): Promise<{ added: boolean; reactions: { emoji: string; count: number }[] }> {
  if (!Number.isInteger(postId) || postId <= 0) {
    const e = new Error("post_id が不正です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const r = await toggleReaction("post", postId, ctx.email, String(emoji ?? ""));
  return {
    added: r.added,
    reactions: r.reactions.map((x) => ({ emoji: x.emoji, count: x.count })),
  };
}

/** 既読マーク（単調・冪等）。 */
export async function agentMarkRead(
  ctx: AgentContext,
  postId: number
): Promise<{ marked: number }> {
  if (!Number.isInteger(postId) || postId <= 0) {
    const e = new Error("post_id が不正です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const marked = await markPostsRead(ctx.email, [postId]);
  return { marked };
}

/** ブックマークトグル（冪等・他者に影響しない）。 */
export async function agentToggleBookmark(
  ctx: AgentContext,
  postId: number
): Promise<{ bookmarked: boolean }> {
  if (!Number.isInteger(postId) || postId <= 0) {
    const e = new Error("post_id が不正です") as Error & { code: string; status: number };
    e.code = "invalid_request";
    e.status = 400;
    throw e;
  }
  const exists = await pool.query(`SELECT 1 FROM posts WHERE id = $1 LIMIT 1`, [postId]);
  if (exists.rows.length === 0) {
    const e = new Error("投稿が見つかりません") as Error & { code: string; status: number };
    e.code = "not_found";
    e.status = 404;
    throw e;
  }
  if (await isBookmarked(ctx.email, postId)) {
    return { bookmarked: await removeBookmark(ctx.email, postId) };
  }
  return { bookmarked: await addBookmark(ctx.email, postId) };
}

/** スレッド 1 本の取得（MCP get_thread 用・API ルートと同一の lib 経路）。 */
export async function agentGetPostDtoById(postId: number, viewerEmail: string) {
  const res = await pool.query(`${POST_SELECT} WHERE p.id = $2 GROUP BY p.id LIMIT 1`, [
    viewerEmail,
    postId,
  ]);
  return res.rows.length ? mapRow(res.rows[0]) : null;
}
