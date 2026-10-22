/* GET /api/agent/openapi.json — OpenAPI 3.1 自己記述（スキルの references/api.md と同一正本）。
 * 認証不要（スキーマ文書そのものは公開情報のみ）。 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const spec = {
  openapi: "3.1.0",
  info: {
    title: "B-guru Agent API",
    version: "1.0.0",
    description:
      "B-guru (bsm.backspace.fm) の AI エージェント向け読み取り API（フェーズ1 MVP）。認証は Authorization: Bearer <token>。エラーは {error, code, hint} に統一（code: unauthorized / token_expired / membership_ended / rate_limited / not_found / forbidden）。識別子は不透明 user_id のみ。email・member 情報は一切レスポンスに含めない。",
  },
  servers: [{ url: "https://bsm.backspace.fm" }],
  components: {
    securitySchemes: {
      bearer: { type: "http", scheme: "bearer" },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "code"],
        properties: {
          error: { type: "string" },
          code: {
            type: "string",
            enum: ["unauthorized", "token_expired", "membership_ended", "rate_limited", "not_found", "forbidden"],
          },
          hint: { type: "string" },
        },
      },
      AgentChatMessage: {
        type: "object",
        properties: {
          id: { type: "integer" },
          author_id: { type: ["string", "null"], description: "不透明 user_id" },
          author_name: { type: ["string", "null"] },
          avatar: { type: ["string", "null"] },
          body: { type: "string" },
          created_at: { type: "string", format: "date-time" },
          edited: { type: "boolean" },
          edited_at: { type: ["string", "null"] },
          is_author: { type: "boolean" },
          mentions_me: { type: "boolean" },
          client_id: { type: "string", description: "送信者本人にだけ返る" },
          reactions: { type: "array" },
        },
      },
      AgentPost: {
        type: "object",
        description:
          "投稿の形（src/lib/agent-post-dto.ts が唯一の正本。一覧・スレッド・投稿直後・検索・MCP で同じ）。項目は消さない・意味を変えない。",
        properties: {
          id: { type: "integer" },
          author_id: { type: "string", description: "不透明 user_id" },
          author_name: { type: ["string", "null"] },
          author_avatar: { type: ["string", "null"], description: "同じオリジンの /api/avatar/<hash> など（gravatar の URL は出さない）" },
          is_author: { type: "boolean", description: "呼び出した本人の投稿か" },
          parent_id: { type: ["integer", "null"] },
          reply_count: { type: "integer" },
          text: { type: "string" },
          images: { type: "array", items: { type: "string" } },
          video_url: { type: ["string", "null"] },
          audio_url: { type: ["string", "null"] },
          url_preview: { type: ["object", "null"] },
          like_count: { type: "integer" },
          created_at: { type: "string", format: "date-time" },
          last_activity_at: { type: "string", format: "date-time" },
          pinned_at: { type: ["string", "null"] },
          club: { type: ["string", "null"] },
          club_manual: { type: "boolean" },
          poll: { type: ["object", "null"] },
          via: { type: ["string", "null"], description: "\"agent\" = AI エージェント経由の投稿" },
          reactions: {
            type: "array",
            description:
              "include=reactions のときだけ。件数の多い順・同数は絵文字の UTF-16 順。count は付けた人の総数、reactors は最大 12 人の表示名（残りは「他 count-12 人」）",
            items: {
              type: "object",
              properties: {
                emoji: { type: "string" },
                count: { type: "integer" },
                mine: { type: "boolean" },
                reactors: { type: "array", items: { type: "string" } },
              },
            },
          },
          unread: { type: "boolean", description: "include=read のときだけ" },
          unread_replies: { type: "integer", description: "include=read のときだけ（ルート投稿）" },
          display: { $ref: "#/components/schemas/PostDisplay" },
        },
      },
      PostDisplay: {
        type: "object",
        description:
          "include=display のときだけ。Web と同じ関数（src/lib/timeline-display.ts）で計算した表示の判断。位置はすべて JS の length（UTF-16 のコード単位）。決まりは docs/timeline-spec.md。",
        properties: {
          version: { type: "integer" },
          fold: { type: "boolean", description: "本文が 500 を超えるので畳んで「続きを読む」を出す" },
          fold_at: { type: ["integer", "null"], description: "畳んだときに見せる本文の長さ（text の先頭からこの位置まで）" },
          reactions_order: { type: "array", items: { type: "string" } },
          reactors_more: { type: "object", additionalProperties: { type: "integer" }, description: "絵文字ごとの「他N人」の N" },
          image_columns: { type: "integer", description: "0〜3。1 のときは最大幅 360px。切り抜かない" },
          link_card_url: { type: ["string", "null"] },
          link_card: {
            type: ["object", "null"],
            description: "kind: spotify（埋め込みだけ・embed_url/embed_height）/ youtube（16:9・最大幅 480・video_id）/ link",
          },
          mention_ranges: {
            type: "array",
            items: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" }, name: { type: "string" } } },
          },
          user_links: {
            type: "array",
            items: { type: "object", properties: { start: { type: "integer" }, end: { type: "integer" }, user_id: { type: "string" } } },
          },
          club_label: { type: ["string", "null"] },
          club_unset: { type: "boolean" },
        },
      },
    },
  },
  security: [{ bearer: [] }],
  paths: {
    "/api/agent/token": {
      post: {
        summary: "トークン発行（UI ログイン済みセッションから・デバイスフローはフェーズ2）",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["device_name"],
                properties: {
                  device_name: { type: "string", maxLength: 100 },
                  scopes: {
                    type: "array",
                    items: { type: "string", enum: ["read", "read_state", "write", "chat"] },
                    description: "既定 read",
                  },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "発行成功。token はこのレスポンスでしか表示されない",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    expiresAt: { type: "string", format: "date-time" },
                    userId: { type: "string" },
                    scopes: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          "401": { description: "未ログイン", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "403": { description: "非会員 / 上限超過", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        summary: "Bearer トークン自身の失効（logout）",
        responses: {
          "200": { description: "失効済み" },
          "401": { description: "無効トークン", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/agent/me": {
      get: {
        summary: "自身の識別子・スコープ・トークン有効期限",
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apiVersion: { type: "integer" },
                    user_id: { type: "string" },
                    scopes: { type: "array", items: { type: "string" } },
                    device_name: { type: "string" },
                    expires_at: { type: "string", format: "date-time" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/agent/posts": {
      get: {
        summary: "タイムライン（cursor ページング・limit 上限 100）",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 50 } },
          { name: "cursor", in: "query", schema: { type: "string" }, description: "next_cursor をそのまま渡す" },
          { name: "since_id", in: "query", schema: { type: "integer" }, description: "この投稿より新しい投稿を返す（ポーリング）" },
          { name: "club", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" } },
          { name: "author_user_id", in: "query", schema: { type: "string" } },
          { name: "fav", in: "query", schema: { type: "string", enum: ["1"] }, description: "お気に入りの投稿者のみ" },
          { name: "bm", in: "query", schema: { type: "string", enum: ["1"] }, description: "ブックマーク済み投稿のみ" },
          {
            name: "include",
            in: "query",
            schema: { type: "string" },
            description: "カンマ区切り: reactions / read / display（capabilities の features.posts.include にあるもの）",
          },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apiVersion: { type: "integer" },
                    posts: { type: "array", items: { $ref: "#/components/schemas/AgentPost" } },
                    next_cursor: { type: ["string", "null"] },
                  },
                },
              },
            },
          },
          "401": { description: "認証エラー", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "429": { description: "レート制限 (read 120/min)", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/agent/posts/{id}": {
      get: {
        summary: "スレッド1本（ルート + 返信）",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "integer" } },
          { name: "include", in: "query", schema: { type: "string" }, description: "カンマ区切り: reactions / read / display" },
        ],
        responses: {
          "200": {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    apiVersion: { type: "integer" },
                    post: { $ref: "#/components/schemas/AgentPost" },
                    replies: { type: "array", items: { $ref: "#/components/schemas/AgentPost" } },
                  },
                },
              },
            },
          },
          "404": { description: "見つからない", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      patch: {
        summary: "自分の投稿の本文編集（text のみ・メディア不可）・スコープ write",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["text"],
                properties: { text: { type: "string", maxLength: 5000 } },
              },
            },
          },
        },
        responses: {
          "200": { description: "編集済み" },
          "403": { description: "自分の投稿のみ", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "見つからない", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
      delete: {
        summary: "自分の投稿の削除・スコープ write",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": { description: "削除済み" },
          "403": { description: "自分の投稿のみ", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "見つからない", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/agent/search": {
      get: {
        summary: "全文検索",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", maximum: 100, default: 50 } },
          { name: "cursor", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/agent/clubs": {
      get: {
        summary: "部活カタログ",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/agent/notifications": {
      get: {
        summary: "自身の通知",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/agent/chat": {
      get: {
        summary: "チャット履歴（24h 以内・古い順）。unread_count / latest_id 付き",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 200, default: 50 } },
          { name: "before", in: "query", schema: { type: "integer" } },
          { name: "include", in: "query", schema: { type: "string", enum: ["reactions"] } },
        ],
        responses: { "200": { description: "{apiVersion, unread_count, latest_id, messages: AgentChatMessage[]}" } },
      },
      post: {
        summary: "チャット送信（スコープ chat）。client_id は楽観表示の照合用で、stream の create にも返る",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["body"],
                properties: {
                  body: { type: "string", maxLength: 1000 },
                  client_id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
                },
              },
            },
          },
        },
        responses: { "201": { description: "{apiVersion, message: AgentChatMessage}" } },
      },
    },
    "/api/agent/chat/{id}": {
      patch: {
        summary: "自分のメッセージを編集（スコープ chat・24h 以内）",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "{apiVersion, message}" }, "403": { description: "編集不可" } },
      },
    },
    "/api/agent/chat/{id}/reactions": {
      post: {
        summary: "チャットへのリアクショントグル（スコープ chat）。{ emoji }（Unicode or :name:）",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "{apiVersion, added, reactions}" }, "404": { description: "メッセージ無し" } },
      },
    },
    "/api/agent/chat/read": {
      post: {
        summary: "チャット既読カーソルを進める（スコープ read_state・単調増加）。{ last_read_id? }",
        responses: { "200": { description: "{apiVersion, unread_count, latest_id}" } },
      },
    },
    "/api/agent/stream": {
      get: {
        summary:
          "個人宛て SSE（スコープ read）。presence に影響しない。events: ready / chat / presence / notification / revoked。1 トークン 3 接続まで",
        responses: { "200": { description: "text/event-stream" } },
      },
    },
    "/api/agent/summary": {
      get: {
        summary: "バッジ用サマリ（チャット未読・通知未読と最新 5 件・在席人数）",
        responses: { "200": { description: "OK" } },
      },
    },
    "/api/agent/capabilities": {
      get: {
        summary: "サーバーが今サポートする機能とトークンで使える操作。クライアントは無い機能を隠し、知らない項目を無視する",
        responses: { "200": { description: "OK" } },
      },
    },
  },
};

export async function GET() {
  return NextResponse.json(spec, {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}
