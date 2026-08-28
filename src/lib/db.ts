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
    CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id, created_at ASC) WHERE parent_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_ghost ON posts(source_ghost_id) WHERE source_ghost_id IS NOT NULL;
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

    -- Per-user read cursor for the chat unread badge.
    CREATE TABLE IF NOT EXISTS chat_read_state (
      email TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- Per-user read cursor for the feed/club unread badges (タイムラインを見ると進む).
    -- 同じ「既読カーソル」の考え方で、最新ルート投稿 id までを既読とする。
    CREATE TABLE IF NOT EXISTS forum_read_state (
      email TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
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
  `);
}
