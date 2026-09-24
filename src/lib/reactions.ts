import { pool } from "./db";

/**
 * Reactions on posts and chat messages.
 *
 * One table serves both targets (`target_type` = 'post' | 'chat') because the
 * behaviour is identical — a user attaches an emoji to a thing, and the same
 * emoji from several users collapses into one chip with a count. Two tables
 * would have meant two copies of every query and two places to fix a bug.
 *
 * `emoji` holds either a literal emoji ("❤️") or a custom-emoji reference in
 * the form ":name:" — the client resolves the latter against /api/emojis.
 * Storing the reference (not the image URL) means renaming or re-uploading a
 * custom emoji updates every existing reaction, which is what users expect.
 */

export type ReactionTarget = "post" | "chat";

/** One emoji's aggregate on a target. */
export type ReactionSummary = {
  emoji: string;
  count: number;
  /** Whether the requesting user is one of the `count`. */
  mine: boolean;
  /** Who reacted, for the tooltip. Capped — see `REACTOR_LIMIT`. */
  reactors: string[];
};

/** Custom emoji registered by a user. */
export type CustomEmoji = {
  id: number;
  name: string;
  imageUrl: string;
  createdBy: string;
  createdAt: string;
};

/** How many reactor names to return per emoji. The tooltip only needs a few;
 *  returning every name for a popular reaction would bloat every feed payload. */
const REACTOR_LIMIT = 12;

/** Custom emoji names are referenced as ":name:" in `emoji`. Restricting the
 *  charset keeps the reference unambiguous (no colons, no whitespace) and stops
 *  a name from being crafted to look like a literal emoji. */
const CUSTOM_NAME_RE = /^[a-z0-9_]{1,32}$/;

export function isCustomEmojiRef(emoji: string): boolean {
  return emoji.startsWith(":") && emoji.endsWith(":") && emoji.length > 2;
}

export function customEmojiName(emoji: string): string | null {
  if (!isCustomEmojiRef(emoji)) return null;
  const name = emoji.slice(1, -1);
  return CUSTOM_NAME_RE.test(name) ? name : null;
}

/**
 * Validate a reaction value before it reaches the database.
 *
 * Accepts a custom reference (":name:") or a short literal emoji. The length
 * cap is the important part: without it a client could store an entire message
 * as a "reaction" and the chip would blow up the layout.
 */
export function isValidReactionValue(emoji: string): boolean {
  if (typeof emoji !== "string") return false;
  if (isCustomEmojiRef(emoji)) return customEmojiName(emoji) !== null;
  // A value that *looks* like a custom reference but is malformed (":", ":x",
  // "::") must be rejected outright rather than falling through to the literal
  // branch — otherwise a bare ":" is stored as a reaction and renders as a
  // stray colon chip. Caught by the unit test for ":".
  if (emoji.includes(":")) return false;
  // A literal emoji: 1-8 code units covers every real emoji including ZWJ
  // sequences and skin-tone modifiers, while rejecting prose.
  return emoji.length > 0 && emoji.length <= 8 && !/[\s]/.test(emoji);
}

/**
 * Toggle a reaction. Returns the new state for that emoji plus the full
 * summary for the target, so the caller can re-render without a second fetch.
 */
export async function toggleReaction(
  targetType: ReactionTarget,
  targetId: number,
  userEmail: string,
  emoji: string
): Promise<{ added: boolean; reactions: ReactionSummary[] }> {
  if (!isValidReactionValue(emoji)) {
    throw new Error("invalid_emoji");
  }

  // A custom reference must point at a registered emoji, otherwise the chip
  // would render as a broken image forever.
  const customName = customEmojiName(emoji);
  if (customName) {
    const found = await pool.query(
      `SELECT 1 FROM custom_emojis WHERE name = $1`,
      [customName]
    );
    if (found.rows.length === 0) throw new Error("unknown_emoji");
  }

  const already = await pool.query(
    `SELECT 1 FROM reactions
      WHERE target_type = $1 AND target_id = $2 AND user_email = $3 AND emoji = $4`,
    [targetType, targetId, userEmail, emoji]
  );

  if (already.rows.length > 0) {
    await pool.query(
      `DELETE FROM reactions
        WHERE target_type = $1 AND target_id = $2 AND user_email = $3 AND emoji = $4`,
      [targetType, targetId, userEmail, emoji]
    );
  } else {
    await pool.query(
      `INSERT INTO reactions (target_type, target_id, user_email, emoji)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (target_type, target_id, user_email, emoji) DO NOTHING`,
      [targetType, targetId, userEmail, emoji]
    );
  }

  return {
    added: already.rows.length === 0,
    reactions: await getReactions(targetType, [targetId], userEmail).then(
      (m) => m.get(targetId) ?? []
    ),
  };
}

/**
 * Reactions for many targets at once, keyed by target id.
 *
 * Batched deliberately: the feed renders 50 posts, and one query per post would
 * be 50 round-trips on every load. `userEmail` marks which chips are the
 * viewer's own.
 */
export async function getReactions(
  targetType: ReactionTarget,
  targetIds: number[],
  userEmail: string | null
): Promise<Map<number, ReactionSummary[]>> {
  const out = new Map<number, ReactionSummary[]>();
  if (targetIds.length === 0) return out;

  const res = await pool.query(
    `SELECT target_id, emoji,
            COUNT(*)::int AS count,
            BOOL_OR(user_email = $3) AS mine,
            (ARRAY_AGG(user_email ORDER BY created_at))[1:${REACTOR_LIMIT}] AS reactors
       FROM reactions
      WHERE target_type = $1 AND target_id = ANY($2::int[])
      GROUP BY target_id, emoji
      -- Most-used first, then stable by emoji so the order does not jitter
      -- between renders when counts tie.
      ORDER BY target_id, count DESC, emoji`,
    [targetType, targetIds, userEmail ?? ""]
  );

  for (const row of res.rows) {
    const id = Number(row.target_id);
    if (!out.has(id)) out.set(id, []);
    out.get(id)!.push({
      emoji: row.emoji,
      count: Number(row.count),
      mine: Boolean(row.mine),
      reactors: row.reactors ?? [],
    });
  }
  return out;
}

/** Register a custom emoji. Names are normalised to lowercase so ":Drikin:"
 *  and ":drikin:" are the same emoji rather than two confusingly similar ones. */
export async function createCustomEmoji(
  name: string,
  imageUrl: string,
  createdBy: string
): Promise<CustomEmoji> {
  const normalised = name.trim().toLowerCase();
  if (!CUSTOM_NAME_RE.test(normalised)) {
    throw new Error("invalid_name");
  }
  try {
    const res = await pool.query(
      `INSERT INTO custom_emojis (name, image_url, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, name, image_url, created_by, created_at`,
      [normalised, imageUrl, createdBy]
    );
    const r = res.rows[0];
    return {
      id: r.id,
      name: r.name,
      imageUrl: r.image_url,
      createdBy: r.created_by,
      createdAt: r.created_at,
    };
  } catch (e: any) {
    if (e.code === "23505") throw new Error("name_taken");
    throw e;
  }
}

export async function listCustomEmojis(): Promise<CustomEmoji[]> {
  const res = await pool.query(
    `SELECT id, name, image_url, created_by, created_at
       FROM custom_emojis ORDER BY created_at DESC`
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    imageUrl: r.image_url,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

/** Delete a custom emoji. Only its creator (or an admin, checked by the route)
 *  may do this. Existing reactions referencing it are removed too — leaving
 *  them would render permanent broken chips. */
export async function deleteCustomEmoji(
  id: number,
  requesterEmail: string,
  isAdmin: boolean
): Promise<void> {
  const found = await pool.query(
    `SELECT name, created_by FROM custom_emojis WHERE id = $1`,
    [id]
  );
  if (found.rows.length === 0) throw new Error("not_found");
  if (!isAdmin && found.rows[0].created_by !== requesterEmail) {
    throw new Error("forbidden");
  }
  const name = found.rows[0].name;
  await pool.query(`DELETE FROM custom_emojis WHERE id = $1`, [id]);
  await pool.query(`DELETE FROM reactions WHERE emoji = $1`, [`:${name}:`]);
}
