/* Dori News (drinews) library.
 * drikin's daily newsletter: only drikin@gmail.com can create/edit/publish.
 * Members can view published articles + comment.
 */
import { pool } from "./db";
import { mdToHtml } from "./md";
import { gravatarUrl } from "./posts";

export const DRINEWS_AUTHOR_EMAIL = "drikin@gmail.com";

export type DrinewsStatus = "draft" | "published";

export interface DrinewsArticle {
  id: number;
  authorEmail: string;
  title: string;
  bodyMd: string;
  bodyHtml: string;
  status: DrinewsStatus;
  scheduledAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  commentCount: number;
}

export interface DrinewsComment {
  id: number;
  articleId: number;
  authorEmail: string;
  authorName: string | null;
  authorAvatar: string | null;
  comment: string;
  createdAt: string;
}

export function isDrikin(email: string): boolean {
  return email.toLowerCase() === DRINEWS_AUTHOR_EMAIL.toLowerCase();
}

const rowToArticle = (r: any): DrinewsArticle => ({
  id: r.id,
  authorEmail: r.author_email,
  title: r.title,
  bodyMd: r.body_md,
  bodyHtml: r.body_html,
  status: r.status,
  scheduledAt: r.scheduled_at ? new Date(r.scheduled_at).toISOString() : null,
  publishedAt: r.published_at ? new Date(r.published_at).toISOString() : null,
  createdAt: new Date(r.created_at).toISOString(),
  updatedAt: new Date(r.updated_at).toISOString(),
  commentCount: Number(r.comment_count) || 0,
});

/** Create a new article (draft). */
export async function createDrinews(input: {
  authorEmail: string;
  title: string;
  bodyMd: string;
  bodyHtml: string;
}): Promise<DrinewsArticle> {
  const res = await pool.query(
    `INSERT INTO drinews_articles (author_email, title, body_md, body_html, status)
     VALUES ($1, $2, $3, $4, 'draft')
     RETURNING *`,
    [input.authorEmail, input.title, input.bodyMd, mdToHtml(input.bodyMd)]
  );
  return rowToArticle(res.rows[0]);
}

/** Update a draft article (only own / drikin). Optionally set a schedule time. */
export async function updateDrinews(
  id: number,
  input: {
    title: string;
    bodyMd: string;
    bodyHtml: string;
    scheduledAt?: string | null;
  }
): Promise<DrinewsArticle> {
  const res = await pool.query(
    `UPDATE drinews_articles
     SET title = $2, body_md = $3, body_html = $4,
         scheduled_at = COALESCE($5, scheduled_at),
         updated_at = now()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, input.title, input.bodyMd, mdToHtml(input.bodyMd), input.scheduledAt ?? null]
  );
  if (res.rows.length === 0) throw new Error("not_found_or_published");
  return rowToArticle(res.rows[0]);
}

/** Publish an article immediately (drikin only). Sets published_at to now. */
export async function publishDrinews(id: number): Promise<DrinewsArticle> {
  const res = await pool.query(
    `UPDATE drinews_articles SET status = 'published', published_at = now(), updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  if (res.rows.length === 0) throw new Error("not_found");
  const article = rowToArticle(res.rows[0]);
  await postDrinewsToFeed(article);
  return article;
}

/** Poster identity for the timeline feed entry (matches episode auto-posts). */
export const FEED_SYSTEM_EMAIL = "system@backspace.fm";
export const FEED_SYSTEM_NAME = "ビーグル";

/**
 * Post a single "new drinews" entry to the timeline feed, as Beagle.
 * Idempotent via the unique index on posts.drinews_article_id — calling this
 * again for the same article is a no-op.
 */
export async function postDrinewsToFeed(article: DrinewsArticle): Promise<void> {
  const portalUrl = process.env.DRINEWS_PORTAL_URL || "https://bsm.backspace.fm";
  const link = `${portalUrl}/?drinews=${article.id}`;
  const text = `📮 ドリニュース更新: ${article.title}\n${link}`;
  const urlPreview = JSON.stringify({ url: link, title: article.title, siteName: "ドリニュース" });
  await pool.query(
    `INSERT INTO posts (author_email, author_name, text, url_preview, source_ghost_id, drinews_article_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, now()))
     ON CONFLICT (drinews_article_id) WHERE drinews_article_id IS NOT NULL DO NOTHING`,
    [
      FEED_SYSTEM_EMAIL,
      FEED_SYSTEM_NAME,
      text,
      urlPreview,
      null,
      article.id,
      article.publishedAt ? new Date(article.publishedAt) : null,
    ]
  );
}

/** Revert a published article back to draft (drikin only). Clears published_at. */
export async function unpublishDrinews(id: number): Promise<DrinewsArticle> {
  const res = await pool.query(
    `UPDATE drinews_articles SET status = 'draft', published_at = NULL, updated_at = now()
     WHERE id = $1 AND status = 'published'
     RETURNING *`,
    [id]
  );
  if (res.rows.length === 0) throw new Error("not_found_or_not_published");
  return rowToArticle(res.rows[0]);
}

/** Delete an article (drikin only). Comments on it are removed via ON DELETE CASCADE. */
export async function deleteDrinews(id: number): Promise<void> {
  const res = await pool.query(`DELETE FROM drinews_articles WHERE id = $1`, [id]);
  if (res.rowCount === 0) throw new Error("not_found");
}

/** List published articles, newest first (for members). */
export async function listPublishedDrinews(): Promise<DrinewsArticle[]> {
  const res = await pool.query(
    `SELECT a.*, (SELECT count(*) FROM drinews_comments c WHERE c.article_id = a.id) AS comment_count
     FROM drinews_articles a
     WHERE a.status = 'published'
     ORDER BY a.published_at DESC`
  );
  return res.rows.map(rowToArticle);
}

/** List all articles including drafts (drikin only). Newest first. */
export async function listAllDrinews(): Promise<DrinewsArticle[]> {
  const res = await pool.query(
    `SELECT a.*, (SELECT count(*) FROM drinews_comments c WHERE c.article_id = a.id) AS comment_count
     FROM drinews_articles a
     ORDER BY COALESCE(a.published_at, a.updated_at) DESC`
  );
  return res.rows.map(rowToArticle);
}

/** Get one article by id. */
export async function getDrinews(id: number): Promise<DrinewsArticle | null> {
  const res = await pool.query(
    `SELECT a.*, (SELECT count(*) FROM drinews_comments c WHERE c.article_id = a.id) AS comment_count
     FROM drinews_articles a WHERE a.id = $1`,
    [id]
  );
  return res.rows.length ? rowToArticle(res.rows[0]) : null;
}

/** Get comments for an article, oldest first. */
export async function listComments(articleId: number): Promise<DrinewsComment[]> {
  const res = await pool.query(
    `SELECT * FROM drinews_comments WHERE article_id = $1 ORDER BY created_at ASC`,
    [articleId]
  );
  return res.rows.map((r) => ({
    id: r.id,
    articleId: r.article_id,
    authorEmail: r.author_email,
    authorName: r.author_name,
    authorAvatar: gravatarUrl(r.author_email),
    comment: r.comment,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

/** Add a comment to a published article (member).
 *  If it did NOT come from a timeline reply (sourcePostId null), mirror it into
 *  the Beagle feed post's replies so both sides stay in sync. */
export async function addComment(
  articleId: number,
  input: { authorEmail: string; authorName: string | null; comment: string },
  opts?: { sourcePostId?: number | null }
): Promise<DrinewsComment> {
  // Only allow commenting on published articles
  const art = await pool.query(`SELECT status FROM drinews_articles WHERE id = $1`, [articleId]);
  if (art.rows.length === 0) throw new Error("not_found");
  if (art.rows[0].status !== "published") throw new Error("not_published");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const res = await client.query(
      `INSERT INTO drinews_comments (article_id, author_email, author_name, comment, source_post_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [articleId, input.authorEmail, input.authorName, input.comment, opts?.sourcePostId ?? null]
    );
    const r = res.rows[0];

    // Mirror: a REAL drinews comment (not from a timeline reply) → add an
    // equivalent reply to the Beagle feed post for this article. The resulting
    // reply carries source_drinews_comment_id so it is never mirrored back.
    if (!opts?.sourcePostId) {
      const feed = await client.query(
        `SELECT id FROM posts WHERE drinews_article_id = $1 AND parent_id IS NULL LIMIT 1`,
        [articleId]
      );
      if (feed.rows.length > 0) {
        await client.query(
          `INSERT INTO posts (author_email, author_name, text, parent_id, source_drinews_comment_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.authorEmail, input.authorName, input.comment, feed.rows[0].id, r.id]
        );
      }
    }

    await client.query("COMMIT");
    return {
      id: r.id,
      articleId: r.article_id,
      authorEmail: r.author_email,
      authorName: r.author_name,
      authorAvatar: gravatarUrl(r.author_email),
      comment: r.comment,
      createdAt: new Date(r.created_at).toISOString(),
    };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

/** Delete a comment. Allowed for the comment author or drikin (admin). */
export async function deleteComment(
  commentId: number,
  userEmail: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await pool.query(`SELECT author_email FROM drinews_comments WHERE id = $1`, [commentId]);
  if (res.rows.length === 0) return { ok: false, error: "not_found" };
  const author = res.rows[0].author_email;
  if (author !== userEmail && !isDrikin(userEmail)) {
    return { ok: false, error: "権限がありません" };
  }
  await pool.query(`DELETE FROM drinews_comments WHERE id = $1`, [commentId]);
  return { ok: true };
}

/** Find the draft article's email author (for permission checks). */
export async function getDrinewsAuthor(id: number): Promise<string | null> {
  const res = await pool.query(`SELECT author_email FROM drinews_articles WHERE id = $1`, [id]);
  return res.rows.length ? res.rows[0].author_email : null;
}

/**
 * Send a published drinews article to all paid members via Mailgun.
 * Each email contains the full article HTML + a link back to the portal for commenting.
 */
export async function sendDrinewsEmail(article: DrinewsArticle): Promise<{
  sent: number;
  skipped: number;
}> {
  const { listMembers, isPaidMember } = await import("./ghost");
  const { sendEmail } = await import("./mailgun");

  const members = await listMembers();
  const recipients = members.filter(isPaidMember).map((m) => m.email);
  const portalUrl = process.env.DRINEWS_PORTAL_URL || "https://bsm.backspace.fm";

  let sent = 0;
  let skipped = 0;
  for (const to of recipients) {
    try {
      await sendEmail({
        to,
        subject: `📮 ドリニュース: ${article.title}`,
        text: `${article.title}\n\n${stripHtml(article.bodyHtml)}\n\n━━━━━━━━━━━━━━━━━━━━━━\n💬 この記事にコメントする／サイトで読む:\n${portalUrl}/?drinews=${article.id}\n━━━━━━━━━━━━━━━━━━━━━━`,
        html: `
          <div style="font-family: 'Hiragino Sans','Meiryo',sans-serif; max-width: 620px; margin: 0 auto; color:#111827;">
            <div style="background:#15803d; color:#fff; padding:18px 24px; border-radius:10px 10px 0 0;">
              <div style="font-size:13px; opacity:0.8;">📮 ドリニュース</div>
              <h1 style="margin:4px 0 0; font-size:22px; line-height:1.4;">${escapeHtml(article.title)}</h1>
            </div>
            <div style="border:1px solid #e5e7eb; border-top:none; border-radius:0 0 10px 10px; padding:24px; line-height:1.8;">
              ${article.bodyHtml}
            </div>
            <div style="text-align:center; margin:24px 0 8px;">
              <a href="${portalUrl}/?drinews=${article.id}" style="display:inline-block; background:#15803d; color:#fff; padding:14px 28px; border-radius:999px; text-decoration:none; font-size:16px; font-weight:bold;">
                💬 サイトで読む・コメントする
              </a>
            </div>
            <p style="text-align:center; font-size:12px; color:#6b7280; margin:4px 0 24px;">
              <a href="${portalUrl}/?drinews=${article.id}" style="color:#6b7280;">${portalUrl}/?drinews=${article.id}</a>
            </p>
          </div>
        `,
      });
      sent++;
    } catch {
      skipped++;
    }
  }
  return { sent, skipped };
}

function stripHtml(html: string): string {
  // Full plain-text version (no truncation — include the entire article body).
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Set an article's scheduled publish time (JST 18:00). Drikin only.
 * Returns the updated article.
 */
export async function scheduleDrinews(
  id: number,
  scheduledAtISO: string
): Promise<DrinewsArticle> {
  const res = await pool.query(
    `UPDATE drinews_articles SET scheduled_at = $2, updated_at = now()
     WHERE id = $1 AND status = 'draft'
     RETURNING *`,
    [id, scheduledAtISO]
  );
  if (res.rows.length === 0) throw new Error("not_found_or_published");
  return rowToArticle(res.rows[0]);
}

/**
 * Process scheduled publications: any draft whose scheduled_at has passed
 * gets published + emailed. Idempotent: only touches drafts, marks published
 * atomically so a crash/retry won't double-email.
 * Returns list of published article ids.
 */
export async function processScheduledDrinews(): Promise<{
  published: number[];
  emailsSent: number;
}> {
  const due = await pool.query(
    `SELECT * FROM drinews_articles
     WHERE status = 'draft' AND scheduled_at <= now()
     ORDER BY scheduled_at ASC
     LIMIT 20`
  );

  const published: number[] = [];
  let emailsSent = 0;

  for (const row of due.rows) {
    // Atomically claim this article as published (prevents double processing)
    const claimed = await pool.query(
      `UPDATE drinews_articles
       SET status = 'published', published_at = COALESCE(scheduled_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'draft'
       RETURNING *`,
      [row.id]
    );
    if (claimed.rows.length === 0) continue; // already handled by another run

    const article = rowToArticle(claimed.rows[0]);
    published.push(article.id);

    try {
      await postDrinewsToFeed(article);
    } catch (e: any) {
      console.error(`drinews feed post failed for #${article.id}:`, e.message);
    }

    try {
      const result = await sendDrinewsEmail(article);
      emailsSent += result.sent;
    } catch (e: any) {
      console.error(`drinews schedule email failed for #${article.id}:`, e.message);
    }
  }

  return { published, emailsSent };
}
