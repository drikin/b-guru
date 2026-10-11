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
      AgentPost: {
        type: "object",
        properties: {
          id: { type: "integer" },
          author_id: { type: "string", description: "不透明 user_id" },
          author_name: { type: ["string", "null"] },
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
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
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
        summary: "チャット履歴（24h 以内・自ユーザー可視分）",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer", maximum: 200, default: 50 } },
          { name: "before", in: "query", schema: { type: "integer" } },
        ],
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
