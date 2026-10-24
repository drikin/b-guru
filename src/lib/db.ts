/* DB connection pool (PostgreSQL) */
import { Pool } from "pg";

const connectionString =
  process.env.DATABASE_URL || "postgres://postgres:@127.0.0.1:5432/bsm";

// Single shared pool
const globalForPool = globalThis as unknown as { __pgPool?: Pool };

export const pool =
  globalForPool.__pgPool ??
  new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPool.__pgPool = pool;
}

/** Init schema (idempotent). Call once at startup. */
export async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS otp_codes (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_otp_email ON otp_codes(email);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author_email TEXT NOT NULL,
      author_name TEXT,
      text TEXT NOT NULL DEFAULT '',
      url_preview JSONB,
      source_ghost_id TEXT,
      parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- Add parent_id if missing (for pre-existing databases)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='parent_id') THEN
        ALTER TABLE posts ADD COLUMN parent_id INTEGER REFERENCES posts(id) ON DELETE CASCADE;
      END IF;
    END $$;
    -- Whisper reply flag: whisper replies do NOT bump the root post's
    -- last_activity, so the group stays put in the timeline.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='is_whisper') THEN
        ALTER TABLE posts ADD COLUMN is_whisper BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;
    END $$;
    -- エージェント由来マーク（"agent"）。書き込み系 agent API / MCP が
    -- 投稿を UI 上で区別できるようにするための透過性フィールド。
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='via') THEN
        ALTER TABLE posts ADD COLUMN IF NOT EXISTS via TEXT;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    -- Per-author lookups (display-name resolution in notifications / presence /
    -- chat, profile timelines) walked idx_posts_created backwards scanning for
    -- the author: measured 17,766 buffers for 30 names on 2026-09-28.
    CREATE INDEX IF NOT EXISTS idx_posts_author_created ON posts(author_email, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at ASC) WHERE parent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_ghost ON posts(source_ghost_id) WHERE source_ghost_id IS NOT NULL;
    -- ★ drinews の表は、下の posts の列（drinews_article_id・source_drinews_comment_id）が参照するので
    --   その前に作る（以前は後ろにあり、空の DB では initSchema が落ちた。既存の DB では何も変わらない）。
    -- Dori News (drinews) — drikin's daily newsletter
    CREATE TABLE IF NOT EXISTS drinews_articles (
      id SERIAL PRIMARY KEY,
      author_email TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      body_md TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',       -- draft | published
      scheduled_at TIMESTAMPTZ,                  -- scheduled publish time (JST 18:00)
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_drinews_status_at ON drinews_articles(status, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_drinews_sched ON drinews_articles(status, scheduled_at) WHERE status = 'draft';
    -- Header image for drinews articles (public URL, viewable in email without auth)
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drinews_articles' AND column_name='header_image') THEN
        ALTER TABLE drinews_articles ADD COLUMN header_image TEXT;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS drinews_comments (
      id SERIAL PRIMARY KEY,
      article_id INTEGER NOT NULL REFERENCES drinews_articles(id) ON DELETE CASCADE,
      author_email TEXT NOT NULL,
      author_name TEXT,
      comment TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_drinews_comments_article ON drinews_comments(article_id, created_at ASC);
    -- Dori News auto-post: which drinews article spawned this feed post
    -- (Beagle posts one entry to the timeline when an article is published).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='drinews_article_id') THEN
        ALTER TABLE posts ADD COLUMN drinews_article_id INTEGER REFERENCES drinews_articles(id) ON DELETE CASCADE;
      END IF;
    END $$;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_drinews ON posts(drinews_article_id) WHERE drinews_article_id IS NOT NULL;
    -- Mirror-link: when a drinews comment is mirrored into the Beagle feed
    -- post's replies, record the originating drinews_comments.id here so we
    -- never re-mirror it back (source_* NULL = the "real" post from this side).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='source_drinews_comment_id') THEN
        ALTER TABLE posts ADD COLUMN source_drinews_comment_id INTEGER REFERENCES drinews_comments(id) ON DELETE CASCADE;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_posts_source_drinews ON posts(source_drinews_comment_id) WHERE source_drinews_comment_id IS NOT NULL;
    -- Video attachment: a post may carry at most ONE video (stored as a single
    -- nullable URL, unlike images which live in the post_images table).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='video_url') THEN
        ALTER TABLE posts ADD COLUMN video_url TEXT;
      END IF;
    END $$;
    -- Audio attachment: a post may carry at most ONE audio file (same single
    -- nullable URL pattern as video_url). Images/video/audio are mutually
    -- exclusive per post — enforced in the composer UI, not the schema.
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='audio_url') THEN
        ALTER TABLE posts ADD COLUMN audio_url TEXT;
      END IF;
    END $$;
    -- 部活動ラベル（auto-classified via さくらのAI Engine）。ルート投稿にのみ付く。
    -- club = 部活キー（src/lib/clubs.ts の CLUB_KEYS）or NULL（該当なし）。
    -- classified_at = 最後に分類/手動変更した時刻（未分類スイーパーが再処理しないための
    --   「試行済み」マーカーも兼ねる）。
    -- club_manual = 投稿者/admin が手動で付け替えた場合 TRUE。自動分類は TRUE の投稿を
    --   上書きしない（将来スイーパーを足しても安全なため）。
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='club') THEN
        ALTER TABLE posts ADD COLUMN club TEXT;
      END IF;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='classified_at') THEN
        ALTER TABLE posts ADD COLUMN classified_at TIMESTAMPTZ;
      END IF;
    END $$;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='posts' AND column_name='club_manual') THEN
        ALTER TABLE posts ADD COLUMN club_manual BOOLEAN NOT NULL DEFAULT FALSE;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_posts_club ON posts(club) WHERE club IS NOT NULL;

    CREATE TABLE IF NOT EXISTS post_images (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_post_images_post ON post_images(post_id);

    CREATE TABLE IF NOT EXISTS post_likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_email TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (post_id, user_email)
    );
    CREATE INDEX IF NOT EXISTS idx_post_likes_post ON post_likes(post_id);

    -- Mirror-link: when a timeline reply to the Beagle feed post is mirrored
    -- into a drinews comment, record the originating posts.id here so we never
    -- re-mirror it back (source_* NULL = the "real" comment from this side).
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='drinews_comments' AND column_name='source_post_id') THEN
        ALTER TABLE drinews_comments ADD COLUMN source_post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE;
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_drinews_comments_source ON drinews_comments(source_post_id) WHERE source_post_id IS NOT NULL;

    -- Notifications: e.g. "your post got a reply"
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY,
      user_email TEXT NOT NULL,          -- recipient
      type TEXT NOT NULL,                -- 'reply' | 'like'
      actor_email TEXT NOT NULL,         -- who triggered it
      actor_name TEXT,
      post_id INTEGER,                   -- the relevant post (parent / source)
      reply_id INTEGER,                  -- the reply post (for type='reply')
      text TEXT NOT NULL,
      read_at TIMESTAMPTZ,               -- NULL = unread
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_email, read_at NULLS FIRST, id DESC);

    -- Admin-managed external-link menu bookmarks (sidebar "メニュー")
    CREATE TABLE IF NOT EXISTS menu_links (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '🔗',
      href TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_menu_links_order ON menu_links(sort_order);
    -- Seed default external links (idempotent: only when table is empty)
    INSERT INTO menu_links (label, icon, href, sort_order)
    SELECT v.label, v.icon, v.href, v.sort_order
    FROM (VALUES
      ('デスブロ', '📺', 'https://dvlog.jp/', 1),
      ('ネタ帳', '🗒️', 'https://neta.backspace.fm/', 2)
    ) AS v(label, icon, href, sort_order)
    WHERE NOT EXISTS (SELECT 1 FROM menu_links);

    -- Realtime community chat (single global room) — the bubble widget
    -- bottom-right. Lightweight, ephemeral back-and-forth between online
    -- members (as opposed to the persistent timeline posts).
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      author_email TEXT NOT NULL,
      author_name TEXT,
      body TEXT NOT NULL DEFAULT '',
      edited BOOLEAN NOT NULL DEFAULT false,
      edited_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(id DESC);
    -- Author self-edits (typo fixes). Idempotent for pre-existing databases.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ;
    -- Photos attached to a chat message (/api/media/chat-… paths, at most 4). They
    -- expire with the message (24 h); the sweeper removes the files too.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS images TEXT[] NOT NULL DEFAULT '{}';
    -- 'notice' = a quiet line from B-guru (who came into / left the room): shown small,
    -- never counted as unread.
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS kind TEXT;
    -- 🐶 端末内 AI のビーグル（kind 'beagle_ai'、lib/beagle-ondevice.ts）: 答えた質問と、答えを作った
    -- 会員の端末（の持ち主）。1 つの質問に答えは 1 つ。
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id INTEGER;
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS ai_by_email TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_beagle_ai_once ON chat_messages(reply_to_id) WHERE kind = 'beagle_ai';
    -- 誰の端末が何を出したかの記録（チャットは 24 時間で消えるので別に 30 日。会員には見せない）。
    CREATE TABLE IF NOT EXISTS beagle_ai_log (
      id SERIAL PRIMARY KEY,
      chat_message_id INTEGER,
      question_id INTEGER NOT NULL,
      question_body TEXT NOT NULL,
      answer TEXT NOT NULL,
      ai_by_email TEXT NOT NULL,
      app TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_beagle_ai_log_created ON beagle_ai_log(created_at);

    -- Per-user read cursor for the chat unread badge.
    CREATE TABLE IF NOT EXISTS chat_read_state (
      email TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Per-user read cursor for the feed/club unread badges (タイムラインを見ると進む).
    -- 同じ「既読カーソル」の考え方で、最新ルート投稿 id までを既読とする。
    --
    -- ★ 2026-09-27: これは**デッドスキーマ**。読み書きするコードが 1 行も無い
    --   （grep -rn 'forum_read_state' src/ はこの CREATE TABLE のみ）。
    --   履歴: c3b3b11 で部活バッジを未読数ベースにするため新設 → 2日後の
    --   df70d9f で「直近7日アクティビティ数」に置換され、/api/clubs/read は削除。
    --   コミットメッセージに「forum_read_state はデッドスキーマとして残置」と明記。
    --
    --   ★ 再利用してはいけない。カーソル方式は「返信を読むと親も既読になる」
    --     （実測: 返信 ID は常に親より大きい）し、COLLAPSE_THRESHOLD=4 で
    --     折りたたまれた返信を開いたときに未読が出ない。per-post が必須。
    --     将来の実装者が「既読はここ」と誤認しないよう、DROP を推奨する。
    CREATE TABLE IF NOT EXISTS forum_read_state (
      email TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Per-post read state (tochi 2026-09-27「PCとスマホの両方でみた場合に、
    -- 未読管理を共通管理にしたい」). 既読の粒度は post.id 単位・返信独立・
    -- 自分の投稿除外で、これは従来の localStorage 実装と同一。保存先だけを
    -- サーバーに移して複数端末で共有する。
    --
    -- ★ カーソル方式（forum_read_state）ではなく per-row にした理由:
    --   返信 ID は常に親より大きいので、カーソルだと「返信を読んだ」で親も
    --   既読になる。さらに COLLAPSE_THRESHOLD=4 で折りたたまれた返信は
    --   親だけが見えるので、カーソルだと開いたときに未読が出ない。
    --   notifications の read_at（per-row 既読）が正しい先行例。
    --
    -- ★ read_at 列は持たない。GET は readIds しか返さないので write-only の
    --   列になり、forum_read_state をデッドスキーマにしたのと同じ過ちになる。
    --
    -- ★ 剪定（保持件数の上限）もしない。jump-to-post は最大 80 ページ × 50 =
    --   4,000 ルートまで遡ってマウントするので、剪定すると古い投稿が未読として
    --   復活する。5,647 行 × 151 人 = 最大 85 万行は PostgreSQL では無視できる。
    CREATE TABLE IF NOT EXISTS post_read_state (
      email   TEXT    NOT NULL,
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      PRIMARY KEY (email, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_post_read_state_email ON post_read_state(email);

    -- 部活の「部長」（各クラブの担当メンバー）。admin のみ管理画面(右SB部長カード)から編集。
    CREATE TABLE IF NOT EXISTS club_leaders (
      club TEXT PRIMARY KEY,
      email TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- 部活カタログ（DB管理・admin が追加/編集/削除できる）。起動時 ensureClubsSeeded で seed。
    -- active=false = 「削除」扱い（一覧/AI分類対象外、既存投稿のラベルは維持）。
    -- manual=true = システム予約（雑談/機能改善/バグ報告）で削除不可。
    CREATE TABLE IF NOT EXISTS clubs (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      definition TEXT NOT NULL DEFAULT '',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      manual BOOLEAN NOT NULL DEFAULT FALSE,
      sort INTEGER NOT NULL DEFAULT 100,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Web Push subscriptions (Push API). One row per (email, endpoint).
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (email, endpoint)
    );

    -- Trend keywords (右SBトレンド・直近24h解析・6時間ごと再生成)
    CREATE TABLE IF NOT EXISTS trend_keywords (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL UNIQUE,
      rank INT NOT NULL,
      hits INT NOT NULL DEFAULT 0,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ビーグルエージェント: 単一状態行（id=1）
    CREATE TABLE IF NOT EXISTS beagle_state (
      id INT PRIMARY KEY DEFAULT 1,
      last_tick_at TIMESTAMPTZ,
      next_activity_at TIMESTAMPTZ,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      memory_bytes INT NOT NULL DEFAULT 0,
      posted_news JSONB NOT NULL DEFAULT '[]'::jsonb,
      watermarks JSONB NOT NULL DEFAULT '{}'::jsonb,
      responded_posts JSONB NOT NULL DEFAULT '[]'::jsonb
    );
    INSERT INTO beagle_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

    -- 既存 DB に responded_posts カラムが無い場合に追加（冪等）
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='beagle_state' AND column_name='responded_posts') THEN
        ALTER TABLE beagle_state ADD COLUMN responded_posts JSONB NOT NULL DEFAULT '[]'::jsonb;
      END IF;
    END $$;

    -- 自発的返信（proactive reply）の日次レア枠カウンタ（JST 1日1回）。
    --   proactive_reply_date = JST 日付文字列（YYYY-MM-DD）、proactive_reply_count = その日の使用数。
    --   日付が変わったら読み出し側で 0 にリセット（行は UPDATE で上書き）。
    ALTER TABLE beagle_state ADD COLUMN IF NOT EXISTS proactive_reply_date TEXT;
    ALTER TABLE beagle_state ADD COLUMN IF NOT EXISTS proactive_reply_count INT NOT NULL DEFAULT 0;

    -- ビーグルエージェント: 監査ログ（全決定・実行を記録）
    CREATE TABLE IF NOT EXISTS beagle_log (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      mode TEXT NOT NULL DEFAULT 'dry',        -- dry | live
      intent TEXT,
      decision JSONB,
      actions JSONB DEFAULT '[]'::jsonb,
      posted_ids INT[] DEFAULT '{}',
      next_activity_at TIMESTAMPTZ,
      error TEXT,
      memory_bytes_before INT NOT NULL DEFAULT 0,
      memory_bytes_after INT NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_beagle_log_run ON beagle_log(run_at);

    -- User profiles (profile timeline). Keyed by posts.author_email.
    -- display_name/bio/header_image are optional; fallback name = latest
    -- posts.author_name, avatar = Gravatar (no custom avatar field).
    CREATE TABLE IF NOT EXISTS user_profiles (
      email TEXT PRIMARY KEY,
      display_name TEXT,
      bio TEXT,
      header_image TEXT,
      links JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_user_profiles_updated ON user_profiles(updated_at DESC);

    -- Per-user club visibility (drikin 2026-10-02): eye toggle in the left
    -- sidebar hides a club's content from the timeline for THIS user only.
    -- Server-persisted so the setting syncs across devices. One row per
    -- (email, club) only when hidden — absence means visible.
    CREATE TABLE IF NOT EXISTS club_visibility (
      email TEXT NOT NULL,
      club_key TEXT NOT NULL,
      hidden BOOLEAN NOT NULL DEFAULT TRUE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (email, club_key)
    );

    -- Per-user club pins (snize 2026-10-17): pinned clubs stay at the top of
    -- the sidebar in pin order (pinned_at) instead of moving with activity.
    -- One row per (email, club) only when pinned. Independent of club_visibility.
    CREATE TABLE IF NOT EXISTS club_pins (
      email TEXT NOT NULL,
      club_key TEXT NOT NULL,
      pinned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (email, club_key)
    );

    -- User identity mapping: opaque public user_id <-> internal email.
    -- Canonical public profile URL is #/user/<user_id> (no email exposure).
    -- email is still the internal key everywhere; this table lets any email
    -- (and any user_id) resolve to the other. One row per known member.
    CREATE TABLE IF NOT EXISTS users (
      user_id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    -- ビーグルが「プロフィール更新を紹介済み」の記録（email 単位で最新紹介時刻を保持）。
    -- 紹介後に再度更新 (updated_at) が進んだら再紹介の対象になる。
    CREATE TABLE IF NOT EXISTS beagle_profile_intros (
      email TEXT PRIMARY KEY,
      introduced_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- ===== 投稿アンケート（投票） =====
    -- 投稿ごとに1つ（0..1）のアンケート。post_id が PK なので1投稿1投票を保証。
    -- ends_at = 締切（投稿 + 選択時間 1h/6h/12h/24h、最大24時間）。必ず持つ。
    CREATE TABLE IF NOT EXISTS post_polls (
      post_id    INT PRIMARY KEY REFERENCES posts(id) ON DELETE CASCADE,
      question   TEXT NOT NULL,
      ends_at    TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_post_polls_ends ON post_polls(ends_at);

    -- 選択肢（デフォルト3・最大10）。並び順で保持。
    CREATE TABLE IF NOT EXISTS post_poll_options (
      id         SERIAL PRIMARY KEY,
      post_id    INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      label      TEXT NOT NULL,
      sort_order INT NOT NULL,
      UNIQUE(post_id, sort_order)
    );

    -- 投票。1票 / 1投稿 / 1ユーザー = UNIQUE(post_id, email) で DB 強制。
    -- 投票変更（締切前）は option_id / updated_at の UPDATE で行う。
    CREATE TABLE IF NOT EXISTS post_poll_votes (
      id         SERIAL PRIMARY KEY,
      post_id    INT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      option_id  INT NOT NULL REFERENCES post_poll_options(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(post_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_post_poll_votes_post ON post_poll_votes(post_id);

    -- お気に入り（viewer が特定の投稿者を追跡）。Instagram の「お気に入り」と同様、
    --   viewer 個人の状態で他ユーザーには影響しない（SSE ブロードキャスト対象外）。
    --   Server-persisted でデバイス間同期。club_visibility / post_read_state と同じ
    --   email 基準の per-user テーブル（FK は張らない — 匿名メンバー・退会後も行保持）。
    --   投稿者側の email は posts.author_email と同一規約（trim + lowercase）。
    CREATE TABLE IF NOT EXISTS user_favorite_authors (
      viewer_email TEXT NOT NULL,
      author_email TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (viewer_email, author_email),
      CHECK (viewer_email <> author_email)
    );
    CREATE INDEX IF NOT EXISTS idx_user_favorite_authors_viewer ON user_favorite_authors(viewer_email);

    -- ブックマーク（viewer が気になった投稿を保存）。Instagram の「保存」と同じ
    --   概念: 投稿単位・viewer 個人の状態で他ユーザーには影響しない（SSE 対象外）。
    --   ☆お気に入り（人を追跡）と 🔖ブックマーク（投稿を保存）は別概念。
    --   post_id に FK ON DELETE CASCADE を張る — 投稿の物理削除（posts.ts deletePost）
    --   でブックマーク行も自動消滅し、bm=1 一覧に壊れた投稿が現れない。
    --   bookmark_count は表示しない（Instagram 同様、他人の保存数は見せない）。
    CREATE TABLE IF NOT EXISTS user_post_bookmarks (
      viewer_email TEXT NOT NULL,
      post_id      BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (viewer_email, post_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_post_bookmarks_viewer ON user_post_bookmarks(viewer_email, created_at DESC);

    -- ===== AI エージェント API（フェーズ1: 読み取り+トークン発行） =====
    -- docs/agent-backend-design.md / docs/beagle-agent-auth-design.md。
    -- token_hash = SHA-256(トークン) のみ保存（平文は発行時 1 回だけ表示）。
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id SERIAL PRIMARY KEY,
      token_hash TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{read}',
      device_name TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      last_used_at TIMESTAMPTZ,
      last_membership_check TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      last_ip INET
    );
    CREATE INDEX IF NOT EXISTS idx_agent_tokens_email ON agent_tokens(email);
    -- 以前は手で作っていて initSchema に無かった表と列（リアクション 2026-09-24・ピン）。本番にはもうあるので
    -- IF NOT EXISTS で何もしない。空の DB（テスト・新しい環境）でだけ作られる。定義はコードの使い方に合わせた
    -- （ON CONFLICT (target_type, target_id, user_email, emoji)・custom_emojis.name の重複は 23505）。
    CREATE TABLE IF NOT EXISTS reactions (
      id SERIAL PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id INTEGER NOT NULL,
      user_email TEXT NOT NULL,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (target_type, target_id, user_email, emoji)
    );
    CREATE TABLE IF NOT EXISTS custom_emojis (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      image_url TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

    -- 「アプリが発行した」印（docs/timeline-spec.md「操作」・オーナー決定 2026-10-22）。人のアプリのログイン
    -- （replace_same_device）で発行した鍵だけが true。設定画面から発行する外部の AI エージェント用の鍵は false。
    ALTER TABLE agent_tokens ADD COLUMN IF NOT EXISTS app_issued BOOLEAN NOT NULL DEFAULT false;

    -- メールでの本人確認（lib/login.ts）。1 行 = 1 通のログインメール。
    -- code_hash / link_hash / revoke_hash は SHA-256 のみ保存（平文はメールにだけ載る）。
    -- revoke_hash = ログイン通知メールの「全端末ログアウト」リンク（30 日有効）。
    CREATE TABLE IF NOT EXISTS login_requests (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      link_hash TEXT UNIQUE NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoke_hash TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_login_requests_email ON login_requests(email, created_at DESC);

    -- 一度だけ流す移行の記録。
    CREATE TABLE IF NOT EXISTS schema_flags (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 既存の鍵への印付け（起動のたびに・冪等）。根拠: 2026-10-20 の login-email-verify-reset で、それより前の
    -- 鍵はすべて失効した。それ以降に発行された鍵で voice スコープを持つのは、アプリのログイン
    -- （replace_same_device: true）で発行したものだけ（/api/agent/token は 2026-10-17 から voice を
    -- アプリのログインにしか付けない。設定画面に voice の選択肢は無い）。期限の自動延長も同じ目印を使っている。
    -- 外部の鍵に voice は付かないので、毎回流しても外部の鍵に印は付かない。
    UPDATE agent_tokens SET app_issued = TRUE WHERE 'voice' = ANY(scopes) AND NOT app_issued;
    -- メール確認なしで入れた頃のログインを全部切る（drikin 2026-10-20: 公開時に全員ログインし直し）。
    -- Web のセッションも、アプリ・AI エージェントのトークンも、確認なしのログインから発行されたため。
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM schema_flags WHERE name = 'login-email-verify-reset') THEN
        DELETE FROM sessions;
        UPDATE agent_tokens SET revoked_at = now() WHERE revoked_at IS NULL;
        INSERT INTO schema_flags (name) VALUES ('login-email-verify-reset');
      END IF;
    END $$;

    -- エージェント API の監査ログ（housekeeping で 90 日で掃除）。
    CREATE TABLE IF NOT EXISTS agent_audit_log (
      id SERIAL PRIMARY KEY,
      token_id INTEGER,
      endpoint TEXT NOT NULL,
      status INTEGER NOT NULL,
      ip TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_audit_created ON agent_audit_log(created_at);

    -- ネイティブアプリ（iPhone/iPad）の APNs 端末トークン。agent token に紐付け、
    -- トークン失効・ログアウト・APNs の 410 で消える。apns_token は端末ごとに一意。
    CREATE TABLE IF NOT EXISTS push_devices (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      agent_token_id INTEGER NOT NULL REFERENCES agent_tokens(id) ON DELETE CASCADE,
      apns_token TEXT UNIQUE NOT NULL,
      environment TEXT NOT NULL DEFAULT 'production',
      platform TEXT NOT NULL DEFAULT 'ios',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_sent_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_push_devices_email ON push_devices(email);
    -- 端末ごとの通知設定: 'all'（新着すべて・まとめて）/ 'mentions'（メンションと返信だけ）。
    -- quiet_hours: 0:00〜7:00 JST は新着を送らない（メンションは送る）。
    ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS notify_mode TEXT NOT NULL DEFAULT 'all';
    ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS quiet_hours BOOLEAN NOT NULL DEFAULT TRUE;
    -- notify_timeline: タイムラインの新しい投稿も知らせる（アプリの設定で選ぶ・既定は送らない）。
    ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS notify_timeline BOOLEAN NOT NULL DEFAULT FALSE;

    -- エージェント API のレート制限カウンタ（固定窓・key=token_id:scope）。
    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL DEFAULT 0
    );

    -- ボイスルーム（lib/voice.ts）。音声は保存しない。開いた回と入退室の記録だけを
    -- モデレーションと監査のために 30 日残す（housekeeping が削除）。user_id は users.user_id。
    CREATE TABLE IF NOT EXISTS voice_sessions (
      id SERIAL PRIMARY KEY,
      livekit_sid TEXT,
      opened_by TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at TIMESTAMPTZ
    );
    -- 開いている回は常に 1 本（同時入室で 2 本立たない）。
    CREATE UNIQUE INDEX IF NOT EXISTS uniq_voice_sessions_open ON voice_sessions((true)) WHERE ended_at IS NULL;
    CREATE TABLE IF NOT EXISTS voice_participations (
      id SERIAL PRIMARY KEY,
      session_id INTEGER REFERENCES voice_sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      left_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_voice_participations_open ON voice_participations(user_id) WHERE left_at IS NULL;
    -- ボイスルームのモデレーション記録（誰が・誰を・何をしたか）。1 年で削除。
    CREATE TABLE IF NOT EXISTS voice_mod_log (
      id SERIAL PRIMARY KEY,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- ボイスルームの通報（通報した人・された人・理由）。管理者に通知も送る。1 年で削除。
    CREATE TABLE IF NOT EXISTS voice_reports (
      id SERIAL PRIMARY KEY,
      reporter_email TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- ルーム（部室）で最後にいた場所（次に入ったときにそこへ戻る）。
    CREATE TABLE IF NOT EXISTS room_positions (
      email TEXT PRIMARY KEY,
      x INT NOT NULL,
      y INT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- ジュークボックス: backspace.fm の過去回（Art19 の公開 RSS から。lib/jukebox.ts）。
    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id SERIAL PRIMARY KEY,
      guid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      published_at TIMESTAMPTZ NOT NULL,
      audio_url TEXT NOT NULL,
      audio_bytes BIGINT NOT NULL DEFAULT 0,
      duration_sec INT,
      summary TEXT NOT NULL DEFAULT '',
      series TEXT NOT NULL DEFAULT '本編',
      number INT,
      web_url TEXT,
      hidden BOOLEAN NOT NULL DEFAULT false,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS podcast_episodes_published_idx ON podcast_episodes (published_at DESC);
    -- 毎朝の「N 年前の今日」の投稿（日本時間の日付ごとに 1 本）。
    CREATE TABLE IF NOT EXISTS jukebox_daily (
      day DATE PRIMARY KEY,
      episode_id INT NOT NULL,
      post_id INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- 管理者が入室禁止にした会員（解除は行を消す）。
    CREATE TABLE IF NOT EXISTS voice_bans (
      email TEXT PRIMARY KEY,
      banned_by TEXT NOT NULL,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    -- ✉️ 簡易 DM（lib/dm.ts）。1 対 1・テキストだけ・24 時間で消える（掃除は ensureDmSweeper）。
    -- チャット（chat_messages）とは別の表。メールは中だけ（応答・配信には users.user_id を出す）。
    CREATE TABLE IF NOT EXISTS dm_messages (
      id SERIAL PRIMARY KEY,
      sender_email TEXT NOT NULL,
      recipient_email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_dm_pair ON dm_messages (LEAST(sender_email, recipient_email), GREATEST(sender_email, recipient_email), id DESC);
    CREATE INDEX IF NOT EXISTS idx_dm_recipient ON dm_messages (recipient_email, id);
    CREATE INDEX IF NOT EXISTS idx_dm_created ON dm_messages (created_at);
    -- 相手ごとの既読（自分 email × 相手 email）。DM と一緒に古いものは消す。
    CREATE TABLE IF NOT EXISTS dm_read_state (
      email TEXT NOT NULL,
      peer_email TEXT NOT NULL,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (email, peer_email)
    );
    -- ☗ 将棋（lib/shogi.ts、docs/shogi-spec.md）。対局者は users.user_id（メールは持たない）。
    -- 正本はここ: 局面（SFEN）・指し手（USI）・持ち時間。残り時間は turn_started_at からその都度出す。
    CREATE TABLE IF NOT EXISTS shogi_games (
      id SERIAL PRIMARY KEY,
      status TEXT NOT NULL,                 -- open | offered | active | ended | closed
      mode TEXT NOT NULL,                   -- blitz | slow
      initial_ms INT NOT NULL DEFAULT 0,
      byoyomi_ms INT NOT NULL DEFAULT 0,
      creator_uid TEXT NOT NULL,
      invitee_uid TEXT,                     -- 指名の相手（NULL = 募集）
      black_uid TEXT,
      white_uid TEXT,
      rematch_of INT,
      sfen TEXT NOT NULL,
      ply INT NOT NULL DEFAULT 0,
      last_usi TEXT,                        -- 最後の手（配信のたびに shogi_moves を読まないため）
      last_label TEXT,
      clock_b_ms INT NOT NULL DEFAULT 0,
      clock_w_ms INT NOT NULL DEFAULT 0,
      turn_started_at TIMESTAMPTZ,
      reminded_at TIMESTAMPTZ,              -- ゆっくり: この手番で 24 時間の通知を送った
      result TEXT,                          -- black | white | draw（中断・取り下げは NULL）
      end_reason TEXT,
      card_msg_id INT,                      -- チャットの対局中カード（chat_messages.id）
      result_post_id INT,                   -- ビーグルの終局投稿（posts.id）
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ended_at TIMESTAMPTZ,
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_shogi_games_live ON shogi_games(status) WHERE status IN ('open', 'offered', 'active');
    CREATE INDEX IF NOT EXISTS idx_shogi_games_ended ON shogi_games(ended_at DESC) WHERE status = 'ended';
    CREATE TABLE IF NOT EXISTS shogi_moves (
      game_id INT NOT NULL REFERENCES shogi_games(id) ON DELETE CASCADE,
      ply INT NOT NULL,
      usi TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      sfen_after TEXT NOT NULL,
      spent_ms INT NOT NULL DEFAULT 0,
      client_move_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (game_id, ply)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_shogi_moves_client ON shogi_moves(game_id, client_move_id) WHERE client_move_id IS NOT NULL;
    -- ☗ ビーグルの実況（lib/shogi-commentary.ts）。手ごとに 1 行。最新の手だけ作るので抜ける手もある。
    -- eval_cp は先手から見た評価（歩 = 100、詰み筋は ±9999）。source は ai（さくらの AI）か template（ひな形）。
    CREATE TABLE IF NOT EXISTS shogi_commentary (
      game_id INT NOT NULL REFERENCES shogi_games(id) ON DELETE CASCADE,
      ply INT NOT NULL,
      move_label TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      eval_cp INT,
      best_usi TEXT,
      best_label TEXT,
      source TEXT NOT NULL DEFAULT 'template',
      highlight TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (game_id, ply)
    );
    -- 実況の見どころをチャットに出した数と最後の時刻（1 局 2 件まで・数分あける。再起動をまたいで守る）。
    ALTER TABLE shogi_games ADD COLUMN IF NOT EXISTS commentary_chat_count INT NOT NULL DEFAULT 0;
    ALTER TABLE shogi_games ADD COLUMN IF NOT EXISTS commentary_chat_at TIMESTAMPTZ;
    -- チャットの対局中カード（kind 'shogi'）がどの対局のものか。
    ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS shogi_game_id INT;
    -- 将棋の通知（shogi_offer / shogi_turn）を受け取る端末。対応したアプリだけが true を送る
    -- （古いアプリは知らない kind を「返信がありました」と出してしまうため、既定は送らない）。
    ALTER TABLE push_devices ADD COLUMN IF NOT EXISTS notify_shogi BOOLEAN NOT NULL DEFAULT FALSE;
    -- 🎮 散財ダッシュ（lib/minigame.ts、docs/minigame-spec.md）。遊んだ人は users.user_id（メールは持たない）。
    -- 1 回ごとに番号と種を発行し（issued、30 分で期限切れ）、操作の記録をサーバで再生してスコアを決める（verified）。
    CREATE TABLE IF NOT EXISTS minigame_plays (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      game TEXT NOT NULL DEFAULT 'dash',
      mode TEXT NOT NULL,                   -- daily（今日のチャレンジ）| free（自由プレイ）
      date_jst DATE,                        -- 今日のチャレンジの日付（JST 5 時区切り）。自由は NULL
      seed INT NOT NULL,
      character TEXT NOT NULL,              -- drikin | matsuo | zenji
      engine_version INT NOT NULL,
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at TIMESTAMPTZ,
      ticks INT,
      score INT,
      distance INT,
      sd INT,
      cause TEXT,
      claimed_score INT,                    -- 端末の申告（照合だけ。記録はサーバの再生の値）
      status TEXT NOT NULL DEFAULT 'issued', -- issued | verified | rejected
      reject_reason TEXT,
      inputs JSONB                          -- 操作の記録。自己ベスト（どれかの順位表に載っている回）の分だけ残す
    );
    CREATE INDEX IF NOT EXISTS idx_minigame_plays_user ON minigame_plays(user_id, issued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_minigame_plays_verified ON minigame_plays(finished_at) WHERE status = 'verified';
    -- 今日のチャレンジの種（日付ごとに 1 つ。全員同じ面）。
    CREATE TABLE IF NOT EXISTS minigame_daily (
      date_jst DATE NOT NULL,
      game TEXT NOT NULL DEFAULT 'dash',
      seed INT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (date_jst, game)
    );
    -- 順位表ごとの各人のベスト（board: d:日付 / w:週の始め / all / all:daily / all:free）。
    CREATE TABLE IF NOT EXISTS minigame_bests (
      game TEXT NOT NULL,
      board TEXT NOT NULL,
      user_id TEXT NOT NULL,
      play_id INT NOT NULL,
      score INT NOT NULL,
      distance INT NOT NULL,
      character TEXT NOT NULL,
      achieved_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (game, board, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_minigame_bests_rank ON minigame_bests(game, board, score DESC, achieved_at);
    -- チャットへの 1 行（1 日 10 行まで、10 分以内の続きは最後の 1 回にまとめる）。
    CREATE TABLE IF NOT EXISTS minigame_announces (
      date_jst DATE NOT NULL,
      game TEXT NOT NULL DEFAULT 'dash',
      lines INT NOT NULL DEFAULT 0,
      last_msg_id INT,
      last_at TIMESTAMPTZ,
      PRIMARY KEY (date_jst, game)
    );
    -- 月曜 9 時の「週の王者」の投稿（週ごとに 1 本）。
    CREATE TABLE IF NOT EXISTS minigame_weekly (
      week_start DATE NOT NULL,
      game TEXT NOT NULL DEFAULT 'dash',
      post_id INT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (week_start, game)
    );
    -- 📺 YouTube 共同鑑賞（lib/watch.ts）: 部室で 1 本。状態は 1 行、見たいものリストは 30 本まで。
    CREATE TABLE IF NOT EXISTS watch_state (
      id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      video_id TEXT,
      title TEXT,
      channel TEXT,
      started_by TEXT,
      playing BOOLEAN NOT NULL DEFAULT false,
      position_s DOUBLE PRECISION NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      version INT NOT NULL DEFAULT 0,
      last_actor TEXT,
      last_action TEXT,
      notice_msg_id INT,
      notice_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS watch_queue (
      id SERIAL PRIMARY KEY,
      video_id TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT,
      added_by TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
