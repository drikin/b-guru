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
      "B-guru (bsm.backspace.fm) の AI エージェント・アプリ向け API。回数の上限（鍵ごと）: read 120/分、read_state 60/分、post 60/時（投稿・アップロード・編集・削除・お題の編集・ネタ帳）、post_light 300/時（リアクション・投票・ブックマーク・お気に入り・ピン・部活の付け替えを post スコープで行ったとき）、段階 3 の新しい操作（編集・削除の画像音声、投票、お題の編集、ピン、部活、お気に入り、動画音声）はアプリのログインで発行した鍵（app_issued）だけ、write 10/時（外部エージェント）。超えると 429 rate_limited。認証は Authorization: Bearer <token>。エラーは {error, code, hint} に統一（code: unauthorized / token_expired / membership_ended / membership_unavailable / rate_limited / not_found / forbidden / invalid_request / server_error）。会員の確認は 6 時間ごと。Ghost に届かないときは前回の確認から 24 時間以内なら通し、超えたら 503 membership_unavailable（ログイン切れではない）。識別子は不透明 user_id のみ。email・member 情報は一切レスポンスに含めない。",
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
            enum: ["unauthorized", "token_expired", "membership_ended", "membership_unavailable", "rate_limited", "not_found", "forbidden", "invalid_request", "server_error"],
            description:
              "membership_unavailable (503): 会員情報を一時的に確認できない（Ghost に届かず、前回の会員確認から 24 時間を超えた）。ログインし直しではない。少し待って再試行する",
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
          bookmarked_by_me: { type: "boolean", description: "見ている本人がブックマークしているか" },
          favorite_by_me: { type: "boolean", description: "見ている本人がこの投稿者をお気に入りにしているか" },
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
          { name: "pinned", in: "query", schema: { type: "string", enum: ["1"] }, description: "今ピン中の投稿だけ（ピンした古い順・next_cursor は null）" },
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
        summary:
          "自分の投稿の編集。アプリのログインで発行した鍵（app_issued）＋ post: { text, images?, audio_url? }（Web と同じ）。それ以外は write で text のみ。post だけの外部の鍵は 403",
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
        summary: "自分の投稿の削除。アプリの鍵（app_issued）＋ post、または write。post だけの外部の鍵は 403",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: {
          "200": { description: "削除済み" },
          "403": { description: "自分の投稿のみ", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          "404": { description: "見つからない", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/api/agent/posts/{id}/pin": {
      post: {
        summary: "ピンの付け外し（アプリの鍵 app_issued＋post だけ・枠 post_light・自分のルート投稿・24 時間・1 人 1 件）→ {apiVersion, ok, pinned}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" }, "403": { description: "他人の投稿・エピソード投稿" }, "404": { description: "無い" } },
      },
    },
    "/api/agent/posts/{id}/club": {
      patch: {
        summary: "部活ラベルの付け替え（アプリの鍵だけ・枠 post_light・投稿者のルート投稿だけ）body {club: key|null} → {apiVersion, ok, club}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" }, "400": { description: "不正な部活" }, "403": { description: "投稿者でない" } },
      },
    },
    "/api/agent/posts/{id}/poll": {
      put: {
        summary: "お題（回答）の編集（アプリの鍵だけ・枠 post・投稿者だけ・投稿後 1 時間・票の付いた選択肢は消せない・id はこの投票の選択肢で重複不可・空の回答不可・3〜10 個）body {question?, options:[{id|null,label}]} → {apiVersion, ok, poll}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" }, "400": { description: "検査に落ちた" }, "403": { description: "投稿者でない・期限切れ" } },
      },
    },
    "/api/agent/posts/{id}/poll/vote": {
      post: {
        summary: "投票（アプリの鍵だけ・枠 post_light・1 人 1 票・締切前なら変更可）body {option_id} → {apiVersion, ok, poll}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" }, "403": { description: "締切後" }, "404": { description: "投票が無い" } },
      },
    },
    "/api/agent/publish": {
      post: {
        summary:
          "アプリからの投稿・返信（スコープ post・人の投稿。video_url・audio_url・poll・club はアプリの鍵だけ、外部の鍵は 403）body {text, images?, parent_id?, whisper?, video_url?, audio_url?, poll?:{question, options, duration_hours?}, club?} → 201 {apiVersion, post}",
        responses: { "201": { description: "作成" }, "400": { description: "検査に落ちた（Web と同じ文言）" } },
      },
    },
    "/api/agent/upload": {
      post: {
        summary:
          "アップロード（スコープ post・multipart。動画・音声はアプリの鍵だけ。10MB 超は同時 3 本まで・超えたら 503）images[]（5 枚・合計 50MB）→ {urls} / video（mp4・webm・mov・100MB）→ {video_url} / audio（100MB）→ {audio_url}",
        responses: { "201": { description: "保存した" }, "400": { description: "形式・大きさ" }, "413": { description: "大きすぎる" } },
      },
    },
    "/api/agent/favorites": {
      get: { summary: "お気に入り（人）の一覧（スコープ read）→ {apiVersion, user_ids}", responses: { "200": { description: "OK" } } },
      post: { summary: "お気に入りに追加（アプリの鍵だけ・枠 post_light・冪等）body {user_id} → {apiVersion, favorited: true}", responses: { "200": { description: "OK" } } },
      delete: { summary: "お気に入りから外す（アプリの鍵だけ・枠 post_light・冪等）body {user_id} → {apiVersion, favorited: false}", responses: { "200": { description: "OK" } } },
    },
    "/api/agent/bookmarks": {
      post: { summary: "ブックマーク（スコープ write か post・post なら枠 post_light）body {post_id, bookmarked?: true|false} → {apiVersion, bookmarked}。bookmarked を送れば冪等、無ければ切り替え", responses: { "200": { description: "OK" } } },
    },
    "/api/agent/emojis": {
      get: { summary: "カスタム絵文字の一覧（スコープ read）→ {apiVersion, emojis:[{id, name, image_url}]}", responses: { "200": { description: "OK" } } },
      post: {
        summary: "カスタム絵文字を登録（multipart: name＝英小文字・数字・_ 32 文字まで、image＝PNG/GIF/WebP/JPEG 256KB まで。スコープ chat・アプリの鍵だけ。誰でも）→ {apiVersion, emoji}",
        responses: { "201": { description: "Created" }, "400": { description: "名前・画像が不正" }, "409": { description: "名前が使われている" }, "429": { description: "1 時間 20 回まで" } },
      },
    },
    "/api/agent/emojis/{id}": {
      delete: {
        summary: "カスタム絵文字を消す（その絵文字のリアクションも消える。スコープ chat・アプリの鍵だけ。誰でも、誰が消したかは記録）→ {ok}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }],
        responses: { "200": { description: "OK" }, "404": { description: "見つからない" }, "429": { description: "1 時間 20 回まで" } },
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
    "/api/agent/clubs/visibility": {
      get: {
        summary: "自分が隠している部活（\"__unset__\" は未設定）。隠した部活のほかの人の投稿はタイムラインに出ない（自分の投稿は出る）",
        responses: { "200": { description: "{apiVersion, hidden: string[]}" } },
      },
      put: {
        summary: "部活を隠す・戻す（アプリの鍵だけ）",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { club: { type: "string" }, hidden: { type: "boolean" } }, required: ["club", "hidden"] } } } },
        responses: { "200": { description: "{apiVersion, club, hidden}" }, "400": { description: "不正な部活キー" } },
      },
    },
    "/api/agent/muted-words": {
      get: {
        summary: "自分の NG ワード（NFKC・小文字にそろえた形）。含むほかの人の投稿・返信はタイムラインに出ず、知らせも来ない（自分の投稿は出る）",
        responses: { "200": { description: "{apiVersion, words: string[], max, maxLength}" } },
      },
      put: {
        summary: "NG ワードを一覧ごと置き換える（アプリの鍵だけ）",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { words: { type: "array", items: { type: "string" } } }, required: ["words"] } } } },
        responses: { "200": { description: "{apiVersion, words}" }, "400": { description: "多すぎる・長すぎる" } },
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
        description:
          "features.mac_assistant (boolean): Mac のアシスタント機能を出すか。MAC_ASSISTANT_ENABLED（未設定=誰にも出さない・メールのカンマ区切り=その人だけ・1=全員）を鍵の持ち主のメールで判定。false・項目なしなら出さない",
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
