/* エージェント書き込み共通 lib（フェーズ2）。
 * /api/agent/* の書き込みルートと MCP ツールの両方から呼ばれる正本。
 * 判断ロジックは置かない: 既存 lib（posts / reactions / read-state-server /
 * bookmarks / notifications / club-store）を 1:1 で包むだけ。
 * 原則: 自分名義のみ（ctx.email を使う・body の author 系は信用しない）、
 * 投稿には via: "agent" を自動付与（UI にエージェント由来マークを出せる）。 */
import { createPost, mapRow, POST_SELECT } from "./posts";
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
import type { FeedPost } from "./feed";

/** 投稿本文の上限（UI 投稿と同水準の暴走ガード）。 */
export const AGENT_POST_MAX_TEXT = 5000;

export function asAgentPostDto(p: FeedPost) {
  return {
    id: p.id,
    author_id: p.authorId,
    author_name: p.authorName ?? null,
    parent_id: p.parentId ?? null,
    text: p.text,
    images: p.images ?? [],
    like_count: p.likeCount ?? 0,
    created_at: p.createdAt,
    last_activity_at: p.lastActivityAt ?? p.createdAt,
    club: p.club ?? null,
  };
}

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
  const parentId =
    Number.isInteger(input.parent_id) && (input.parent_id as number) > 0
      ? (input.parent_id as number)
      : null;
  const authorName = await resolveAuthorName(ctx.email);
  const post = await createPost({
    authorEmail: ctx.email,
    authorName,
    text,
    parentId,
    via: "agent",
  });

  // 部活ラベルの明示指定（任意）。有効キーのみ受け付ける（無効値は黙って捨てる）。
  const club = typeof input.club === "string" ? input.club.trim() : "";
  if (club && !parentId && (await isActiveClubKey(club))) {
    await pool.query(`UPDATE posts SET club = $2, club_manual = TRUE WHERE id = $1`, [
      post.id,
      club,
    ]);
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
