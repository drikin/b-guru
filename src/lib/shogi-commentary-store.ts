/* ☗ ビーグルの実況 — 機能フラグと DB（shogi_commentary）。lib/shogi.ts からも読むので、shogi.ts を import しない。
 *
 *   SHOGI_COMMENTARY_ENABLED（読み方は lib/feature-flag.ts）:
 *     未設定・"0" = 作らない・出さない / メールのカンマ区切り = その人にだけ出す（作るのは全部の対局）/ "1" = 全員
 *   公開前（"1" 以外）はチャットにも終局投稿にも出さない（「告知しない」の決まり）。プッシュには出さない。 */
import { pool } from "./db";
import { postChatNotice } from "./chat";
import { featureEnabledFor, featureOnForAnyone, featurePublic } from "./feature-flag";
import { HIGHLIGHT_GAP_MS, MAX_MIDGAME_HIGHLIGHTS, mateSide, turningPoints, type Highlight } from "./shogi-commentary-core";
import type { ShogiCommentaryDto } from "./shogi-types";

export const COMMENTARY_FLAG = "SHOGI_COMMENTARY_ENABLED";

/** この人に実況を見せるか（将棋そのものが有効なことも条件）。 */
export function commentaryEnabledFor(email: string | null | undefined): boolean {
  return featureEnabledFor("SHOGI_ENABLED", email) && featureEnabledFor(COMMENTARY_FLAG, email);
}

/** 実況を作るか（誰か 1 人にでも出しているとき。見ている人がいなくても、途中から開いた人に最新を出せるように作る）。 */
export function commentaryOn(): boolean {
  return featureOnForAnyone(COMMENTARY_FLAG);
}

/** 公開前（メールのカンマ区切り）のときの、実況を見せる人のメール（小文字）。公開中・未設定は空。 */
export function commentaryFlagEmails(): Set<string> {
  if (commentaryPublic()) return new Set();
  return new Set(
    (process.env[COMMENTARY_FLAG] ?? "")
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.includes("@"))
  );
}

/** 全員に公開しているか。公開前はチャットの見どころ・終局投稿の「分かれ目」を出さない。 */
export function commentaryPublic(): boolean {
  return featurePublic(COMMENTARY_FLAG);
}

export type CommentaryRow = {
  game_id: number;
  ply: number;
  move_label: string;
  text: string;
  eval_cp: number | null;
  best_usi: string | null;
  best_label: string | null;
  source: "ai" | "template";
  highlight: Highlight | null;
  created_at: Date;
};

export function toCommentaryDto(r: CommentaryRow): ShogiCommentaryDto {
  return {
    game_id: r.game_id,
    ply: r.ply,
    move_label: r.move_label,
    text: r.text,
    eval_cp: r.eval_cp,
    mate: mateSide(r.eval_cp),
    best: r.best_usi ? { usi: r.best_usi, label: r.best_label ?? "" } : null,
    source: r.source === "ai" ? "ai" : "template",
    highlight: r.highlight === "reversal" || r.highlight === "mate" ? r.highlight : null,
    at: new Date(r.created_at).toISOString(),
  };
}

/** 1 手ぶんを保存（同じ手は上書き）。 */
export async function saveCommentary(r: Omit<CommentaryRow, "created_at">): Promise<CommentaryRow> {
  const q = await pool.query(
    `INSERT INTO shogi_commentary (game_id, ply, move_label, text, eval_cp, best_usi, best_label, source, highlight)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (game_id, ply) DO UPDATE SET move_label = EXCLUDED.move_label, text = EXCLUDED.text, eval_cp = EXCLUDED.eval_cp,
       best_usi = EXCLUDED.best_usi, best_label = EXCLUDED.best_label, source = EXCLUDED.source,
       highlight = COALESCE(EXCLUDED.highlight, shogi_commentary.highlight), created_at = now()
     RETURNING *`,
    [r.game_id, r.ply, r.move_label, r.text, r.eval_cp, r.best_usi, r.best_label, r.source, r.highlight]
  );
  return q.rows[0] as CommentaryRow;
}

export async function commentaryAt(gameId: number, ply: number): Promise<CommentaryRow | null> {
  const q = await pool.query(`SELECT * FROM shogi_commentary WHERE game_id = $1 AND ply = $2`, [gameId, ply]);
  return (q.rows[0] as CommentaryRow) ?? null;
}

export async function latestCommentary(gameId: number): Promise<CommentaryRow | null> {
  const q = await pool.query(`SELECT * FROM shogi_commentary WHERE game_id = $1 ORDER BY ply DESC LIMIT 1`, [gameId]);
  return (q.rows[0] as CommentaryRow) ?? null;
}

export async function allCommentary(gameId: number): Promise<CommentaryRow[]> {
  const q = await pool.query(`SELECT * FROM shogi_commentary WHERE game_id = $1 ORDER BY ply`, [gameId]);
  return q.rows as CommentaryRow[];
}

/** 見どころをチャットに 1 行出す（1 局 2 件まで・間を数分あける・対局中だけ）。出したら true。
 *  対局の行をロックしたまま「まだ対局中か・枠があるか」を確かめて入れるので、終局（同じ行をロックする）の
 *  カードの書き換え・終局投稿のあとに見どころが割り込むことはない。同時に来ても 1 つだけ通る。 */
export async function postHighlightIfActive(gameId: number, body: string): Promise<boolean> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const q = await c.query(
      `SELECT status, commentary_chat_count AS n,
              (commentary_chat_at IS NULL OR commentary_chat_at <= now() - make_interval(secs => $2::double precision / 1000)) AS gap_ok
         FROM shogi_games WHERE id = $1 FOR UPDATE`,
      [gameId, HIGHLIGHT_GAP_MS]
    );
    const r = q.rows[0] as { status: string; n: number; gap_ok: boolean } | undefined;
    if (!r || r.status !== "active" || r.n >= MAX_MIDGAME_HIGHLIGHTS || !r.gap_ok) {
      await c.query("ROLLBACK");
      return false;
    }
    await c.query(`UPDATE shogi_games SET commentary_chat_count = commentary_chat_count + 1, commentary_chat_at = now() WHERE id = $1`, [gameId]);
    await postChatNotice(body, null, c);
    await c.query("COMMIT");
    return true;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** 終局投稿の「分かれ目」（評価が大きく動いた 3 手まで）。公開前・実況がなければ空。 */
export async function turningPointLines(gameId: number, names: { black: string; white: string }): Promise<string[]> {
  if (!commentaryPublic()) return [];
  const rows = await allCommentary(gameId).catch(() => [] as CommentaryRow[]);
  return turningPoints(rows, names);
}
