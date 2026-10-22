/* アプリ用 API（/api/agent/*）と MCP が返す投稿の形 — ただ 1 つの正本。
 *
 * 以前は 2 つあった: GET /api/agent/posts の agentPostDto（アバター・動画・音声・
 * 投票・ピンなど全部入り）と、agent-write.ts の asAgentPostDto（投稿直後と
 * since_id の取得で使う、項目の少ない版）。同じ投稿が経路によって違う形で返り、
 * アプリの投稿直後のカードにアバターや動画が出ない原因になっていた。
 *
 * 決まり:
 *  - 項目は消さない・意味を変えない（古いアプリが壊れないように）。足すのは自由。
 *  - email 系は出さない（author_id は不透明 user_id）。アバターは同じオリジンの
 *    /api/avatar/<hash>（gravatar の URL はメールのハッシュを含むため出さない）。
 *  - 形を変えたら openapi（src/app/api/agent/openapi.json/route.ts の AgentPost）と
 *    docs/timeline-spec.md も直す。 */
import { toProxiedAvatar } from "./members";
import type { FeedPost } from "./posts";

export type AgentPostDto = {
  id: number;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  is_author: boolean;
  parent_id: number | null;
  reply_count: number;
  text: string;
  images: string[];
  video_url: string | null;
  audio_url: string | null;
  url_preview: FeedPost["urlPreview"];
  like_count: number;
  created_at: string;
  last_activity_at: string;
  pinned_at: string | null;
  club: string | null;
  club_manual: boolean;
  poll: FeedPost["poll"] | null;
  /** "agent" = AI エージェント経由の投稿（Web は名前の横に 🤖）。人の投稿は null。 */
  via: string | null;
};

type PostLike = Partial<FeedPost> & Pick<FeedPost, "id" | "text" | "createdAt">;

export function agentPostDto(p: PostLike): AgentPostDto {
  return {
    id: p.id,
    author_id: p.authorId as string,
    author_name: p.authorName ?? null,
    author_avatar: toProxiedAvatar(p.authorAvatar),
    is_author: !!p.isAuthor,
    parent_id: p.parentId ?? null,
    reply_count: p.replyCount ?? 0,
    text: p.text,
    images: p.images ?? [],
    video_url: p.videoUrl ?? null,
    audio_url: p.audioUrl ?? null,
    url_preview: p.urlPreview ?? null,
    like_count: p.likeCount ?? 0,
    created_at: p.createdAt,
    last_activity_at: p.lastActivityAt ?? p.createdAt,
    pinned_at: p.pinnedAt ?? null,
    club: p.club ?? null,
    club_manual: !!p.clubManual,
    poll: p.poll ?? null,
    via: p.via ?? null,
  };
}
