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
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_chat_created ON chat_messages(id DESC);

    -- Per-user read cursor for the chat unread badge.
    CREATE TABLE IF NOT EXISTS chat_read_state (
      email TEXT PRIMARY KEY,
      last_read_id INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}
