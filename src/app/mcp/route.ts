/* /mcp — リモート MCP サーバー（Streamable HTTP・別プロセスなし）。
 *
 * 設計原則:
 *  - 「API が正本」: ツールは既存 /api/agent/* と同一の lib（agent-auth /
 *    agent-write / posts / chat / club-store / notifications）を 1:1 で包む
 *    薄いラッパー。新しい判断ロジックは書かない。
 *  - 認証: Authorization Bearer → verifyAgentToken を lib 直呼び（内部 HTTP
 *    呼び出しはしない）。スコープ強制も共通 requireScope を使用。
 *  - エラーは {error, code, hint} をツールレスポンスにそのまま流す。
 *    membership_ended 時は hint に BSM 会員案内を必ず含める。
 *  - ステートレス（sessionIdGenerator: undefined）: pm2 fork 単一プロセス・
 *    再起動でセッションを失ってもクライアントが壊れない。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { listPostsSince } from "@/lib/agent-posts-since";
import {
  verifyAgentToken,
  requireScope,
  checkRateLimit,
  recordAudit,
  AgentAuthError,
  sanitizeLikePattern,
  type AgentContext,
  type AgentScope,
} from "@/lib/agent-auth";
import { listPosts, getPostThread } from "@/lib/posts";
import { getHiddenClubs } from "@/lib/club-visibility";
import { getFavoriteEmails } from "@/lib/favorites";
import { getBookmarkedPostIds } from "@/lib/bookmarks";
import { userIdToEmail } from "@/lib/user";
import { listChatMessages } from "@/lib/chat";
import { listClubs } from "@/lib/club-store";
import { listNotifications } from "@/lib/notifications";
import {
  agentCreatePost,
  agentUpdatePost,
  agentDeletePost,
  agentToggleReaction,
  agentMarkRead,
  agentToggleBookmark,
  asAgentPostDto,
} from "@/lib/agent-write";
import { agentPostDto } from "@/app/api/agent/posts/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEMBERSHIP_HINT = "BSM 会員資格を確認できません。backspace.fm でご確認ください";

/** AgentAuthError / 書き込みエラーをツールレスポンス用の {error, code, hint} へ。
 *  内部エラー（pg ドライバ等）の message は流出させない（REST と同一の規約）。 */
function errorBody(e: unknown): { error: string; code: string; hint?: string } {
  if (e instanceof AgentAuthError) {
    const b = { ...e.body };
    if (b.code === "membership_ended") b.hint = MEMBERSHIP_HINT;
    return b;
  }
  // AgentAuthError 以外は詳細を返さない（内部メッセージ/SQL エラーの漏洩防止）。
  return { error: "サーバーエラー", code: "server_error" };
}

/** スコープ必須のツール実行。認証/スコープ/レート制限/監査の漏れを型で防ぐ。 */
async function withTool<T>(
  req: Request,
  scope: AgentScope | null,
  endpoint: string,
  fn: (ctx: AgentContext) => Promise<T>
): Promise<T | { __error: ReturnType<typeof errorBody> }> {
  let ctx: AgentContext | null = null;
  try {
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip");
    ctx = await verifyAgentToken(req.headers.get("authorization"), { ip });
    if (scope) requireScope(ctx, scope);
    if (scope) {
      // REST /api/agent/* と同一の per-scope レート制限（MCP 経由でも write 10/h 等を強制）。
      const rate = await checkRateLimit(ctx.tokenId, scope);
      if (!rate.allowed) {
        throw new AgentAuthError(429, {
          error: "レート制限に達しました",
          code: "rate_limited",
          hint: `${rate.retryAfter} 秒後に再試行してください`,
        });
      }
    }
    const out = await fn(ctx);
    await recordAudit(ctx.tokenId, `mcp:${endpoint}`, 200, ip);
    return out;
  } catch (e) {
    const status = e instanceof AgentAuthError ? e.status : 500;
    try {
      await recordAudit(ctx?.tokenId ?? null, `mcp:${endpoint}`, status, null);
    } catch { /* best effort */ }
    return { __error: errorBody(e) };
  }
}

function buildServer(ctx: AgentContext) {
  const server = new McpServer({ name: "bsm-b-guru", version: "1.0.0" });

  server.registerTool(
    "get_me",
    {
      title: "自分の情報",
      description:
        "自分の user_id / スコープ / デバイス名 / トークン有効期限を取得する（user_id 以外の個人情報は返さない）",
      inputSchema: {},
    },
    async () => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            user_id: ctx.userId,
            scopes: ctx.scopes,
            device_name: ctx.deviceName,
            expires_at: ctx.expiresAt,
          }),
        },
      ],
    })
  );

  server.registerTool(
    "get_posts",
    {
      title: "タイムライン取得",
      description:
        "B-guru のタイムラインを取得する。club（部活キー）/ search（部分一致）/ since_id（この投稿より新しい投稿のみ・ポーリング用）/ fav（お気に入り作者のみ）/ bm（自分のブックマークのみ）/ author_user_id（特定ユーザーのみ）でフィルタできる。cursor でページング（next_cursor を続けて渡す）",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("取得件数（既定50・最大100）"),
        cursor: z.string().optional().describe("前回レスポンスの next_cursor"),
        club: z.string().optional().describe("部活キーで絞り込み"),
        search: z.string().optional().describe("本文部分一致検索"),
        since_id: z.number().int().optional().describe("この投稿 ID より新しい投稿のみ（ポーリング用）"),
        fav: z.boolean().optional().describe("true=お気に入り作者の投稿のみ"),
        bm: z.boolean().optional().describe("true=自分のブックマークのみ"),
        author_user_id: z.string().optional().describe("特定ユーザーの投稿のみ（get_me の user_id 形式）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "read", "get_posts", async (c) => {
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
        const search = sanitizeLikePattern(args.search);
        const rawSince = typeof args.since_id === "number" ? args.since_id : NaN;
        if (Number.isInteger(rawSince) && rawSince > 0) {
          const hiddenArr = Array.from(await getHiddenClubs(c.email));
          return { apiVersion: 1, posts: (await listPostsSince(c, rawSince, limit, hiddenArr)).map(asAgentPostDto), next_cursor: null, has_more: true };
        }
        const authorEmail = args.author_user_id ? await userIdToEmail(args.author_user_id) : undefined;
        if (args.author_user_id && !authorEmail) {
          return { error: "ユーザーが見つかりません", code: "not_found" };
        }
        const hiddenSet = await getHiddenClubs(c.email);
        const favoriteAuthors = args.fav ? Array.from(await getFavoriteEmails(c.email)) : undefined;
        const bookmarkedIds = args.bm ? await getBookmarkedPostIds(c.email) : undefined;
        const posts = await listPosts({
          search,
          club: args.club,
          excludeClubs: Array.from(hiddenSet),
          favoriteAuthors,
          bookmarkedIds,
          viewerEmail: c.email,
          before: args.cursor || undefined,
          limit,
          author: authorEmail || undefined,
        });
        const last = posts[posts.length - 1];
        return {
          apiVersion: 1,
          posts: posts.map(agentPostDto),
          next_cursor: posts.length === limit && last ? (last.lastActivityAt ?? last.createdAt) : null,
        };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "get_thread",
    {
      title: "スレッド取得",
      description: "投稿 1 本とその返信一覧を取得する",
      inputSchema: { post_id: z.number().int().positive().describe("投稿 ID") },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "read", "get_thread", async (c) => {
        const { post, replies } = await getPostThread(args.post_id, c.email);
        if (!post) return { error: "投稿が見つかりません", code: "not_found" };
        return { apiVersion: 1, post: agentPostDto(post), replies: replies.map(agentPostDto) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "search_posts",
    {
      title: "投稿検索",
      description: "本文の全文検索（部分一致）。cursor でページング",
      inputSchema: {
        q: z.string().min(1).describe("検索語"),
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().optional(),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "read", "search_posts", async (c) => {
        const q = sanitizeLikePattern(args.q);
        if (!q) return { error: "q パラメータが必要です", code: "invalid_request" };
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
        const hiddenSet = await getHiddenClubs(c.email);
        const posts = await listPosts({
          search: q,
          excludeClubs: Array.from(hiddenSet),
          viewerEmail: c.email,
          before: args.cursor || undefined,
          limit,
        });
        const last = posts[posts.length - 1];
        return {
          apiVersion: 1,
          query: q,
          posts: posts.map(agentPostDto),
          next_cursor: posts.length === limit && last ? (last.lastActivityAt ?? last.createdAt) : null,
        };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "get_clubs",
    {
      title: "部活一覧",
      description: "アクティブな部活カタログ（key / name / category / definition）を取得する",
      inputSchema: {},
    },
    async () => {
      const out = await withTool(req_of(ctx), "read", "get_clubs", async () => {
        const clubs = await listClubs({ activeOnly: true });
        return {
          apiVersion: 1,
          clubs: clubs.map((c) => ({ key: c.key, name: c.name, category: c.category, definition: c.definition })),
        };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "get_notifications",
    {
      title: "通知取得",
      description: "自分に届いた通知（返信・メンション等）を新しい順に取得する",
      inputSchema: {},
    },
    async () => {
      const out = await withTool(req_of(ctx), "read", "get_notifications", async (c) => {
        const list = await listNotifications(c.email);
        return { apiVersion: 1, notifications: list };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "get_chat",
    {
      title: "チャット履歴",
      description: "チャットの履歴を取得する（時系列・古い順）。before でそれより前のメッセージを取得",
      inputSchema: {
        before: z.number().int().positive().optional().describe("このメッセージ ID より前を取得（ページング）"),
        limit: z.number().int().min(1).max(200).optional().describe("取得件数（既定50・最大200）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "read", "get_chat", async (c) => {
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const messages = await listChatMessages({ limit, before: args.before, viewerEmail: c.email });
        return {
          apiVersion: 1,
          messages: messages.map((m) => ({
            id: m.id,
            author_id: m.authorId,
            author_name: m.authorName,
            body: m.body,
            created_at: m.createdAt,
            edited: m.edited,
            edited_at: m.editedAt,
          })),
        };
      });
      return wrap(out);
    }
  );

  // ---- 書き込み系（スコープ強制は各ツールの scope 引数で行う） ----

  server.registerTool(
    "post_message",
    {
      title: "投稿・返信",
      description:
        "自分名義で新規投稿する。parent_id を付けると返信になる。club は部活キー（get_clubs で取得・ルート投稿のみ）。投稿には via: agent のマークが付く",
      inputSchema: {
        text: z.string().min(1).max(5000).describe("投稿本文（最大5000文字）"),
        parent_id: z.number().int().positive().optional().describe("返信先の投稿 ID"),
        club: z.string().optional().describe("部活キー（ルート投稿のみ）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "write", "post_message", async (c) => {
        const post = await agentCreatePost(c, {
          text: args.text,
          parent_id: args.parent_id ?? null,
          club: args.club ?? null,
        });
        return { apiVersion: 1, post: asAgentPostDto(post) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "edit_post",
    {
      title: "投稿編集",
      description: "自分の投稿の本文を編集する（text のみ・メディアの付け替えは不可）",
      inputSchema: {
        post_id: z.number().int().positive().describe("投稿 ID（自分の投稿のみ）"),
        text: z.string().min(1).max(5000).describe("新しい本文（最大5000文字）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "write", "edit_post", async (c) => {
        return { apiVersion: 1, ...(await agentUpdatePost(c, args.post_id, { text: args.text })) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "delete_post",
    {
      title: "投稿削除",
      description: "自分の投稿を削除する",
      inputSchema: {
        post_id: z.number().int().positive().describe("投稿 ID（自分の投稿のみ）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "write", "delete_post", async (c) => {
        return { apiVersion: 1, ...(await agentDeletePost(c, args.post_id)) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "add_reaction",
    {
      title: "リアクション",
      description: "投稿に絵文字リアクションを付ける/外す（トグル・投稿のみ）",
      inputSchema: {
        post_id: z.number().int().positive().describe("投稿 ID"),
        emoji: z.string().min(1).max(8).describe("絵文字（例: 👍 / :custom:）"),
      },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "write", "add_reaction", async (c) => {
        return { apiVersion: 1, ...(await agentToggleReaction(c, args.post_id, args.emoji)) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "mark_read",
    {
      title: "既読マーク",
      description: "投稿を既読にする（単調・冪等）",
      inputSchema: { post_id: z.number().int().positive().describe("投稿 ID") },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "read_state", "mark_read", async (c) => {
        return { apiVersion: 1, ...(await agentMarkRead(c, args.post_id)) };
      });
      return wrap(out);
    }
  );

  server.registerTool(
    "toggle_bookmark",
    {
      title: "ブックマーク",
      description: "投稿をブックマークする/外す（トグル・冪等）",
      inputSchema: { post_id: z.number().int().positive().describe("投稿 ID") },
    },
    async (args) => {
      const out = await withTool(req_of(ctx), "write", "toggle_bookmark", async (c) => {
        return { apiVersion: 1, ...(await agentToggleBookmark(c, args.post_id)) };
      });
      return wrap(out);
    }
  );

  return server;
}

/** withTool の結果を MCP ツールレスポンスへ正規化。エラーは {error, code, hint}
 * をそのまま流す（isError: true・サーバーは落とさない）。 */
function wrap(out: unknown) {
  if (out && typeof out === "object" && "__error" in (out as Record<string, unknown>)) {
    return {
      isError: true as const,
      content: [{ type: "text" as const, text: JSON.stringify((out as { __error: unknown }).__error) }],
    };
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(out) }] };
}

// ctx はクロージャで req を持たないため、認証済みコンテキストごとに req を
// 記録して withTool に渡す（同一リクエスト内でのみ使う）。
const ctxReqs = new WeakMap<object, Request>();
function req_of(ctx: AgentContext): Request {
  return ctxReqs.get(ctx as unknown as object) ?? new Request("http://internal/");
}

export async function POST(req: Request) {
  try {
    // 認証はルート層で 1 回だけ実施。失敗時は MCP セッションを作らず
    // {error, code, hint} を 401/403 で返す（Claude は接続画面に表示する）。
    const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip");
    let ctx: AgentContext;
    try {
      ctx = await verifyAgentToken(req.headers.get("authorization"), { ip });
    } catch (e) {
      const body = errorBody(e);
      const status = e instanceof AgentAuthError ? e.status : 500;
      return Response.json(body, { status });
    }

    // 同一リクエスト内での再検証を避けるため、ctx をキャッシュ済みと扱う:
    // withTool は verifyAgentToken をもう一度呼ぶが、これは冪等かつ設計
    // （使用記録・会員 6h キャッシュ）上安全。代わりに req を紐付ける。
    ctxReqs.set(ctx as unknown as object, req);

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
      enableJsonResponse: true,
    });
    const server = buildServer(ctx);
    await server.connect(transport);
    const res = await transport.handleRequest(req);
    // server はリクエスト単位で廃棄（長ライブ接続を持たない）。
    void server.close();
    return res;
  } catch (e) {
    console.error("[mcp]", (e as Error)?.message);
    return Response.json({ error: "サーバーエラー", code: "server_error" }, { status: 500 });
  }
}

// GET (SSE 系) はステートレス構成では使わない。Claude は POST のみで動く。
export async function GET() {
  return Response.json(
    { error: "GET は非対応です", code: "invalid_request", hint: "MCP クライアントから POST で接続してください" },
    { status: 405 }
  );
}
