/* ビーグルエージェント: 実行（ビーグル名義で投稿/コメント） */
import { createPost } from "../posts";
import { pool } from "../db";
import { SYSTEM_EMAIL, SYSTEM_NAME } from "./store";
import type { BeagleAction, BeagleDecision } from "./types";

const MAX_TEXT = 1500;
const MAX_POSTS = 1; // 1 tick でルート投稿は最大1本（proactive を抑制）
const MAX_REPLIES = 3; // 1 tick で返信は最大3件（言及は優先）
const MAX_REPLIES_HARD = 8; // 明示 @ビーグル 多数時も暴走させない絶対上限

/** 返信予算: 明示メンション数 + 余裕を下限に（同一スレッド内の複数コメントにも必ず反応）。
 *  暴走防止のため絶対上限でクランプ。 */
export function replyBudget(explicitMentionCount: number): number {
  if (explicitMentionCount <= 0) return MAX_REPLIES;
  return Math.min(MAX_REPLIES_HARD, explicitMentionCount + 2);
}

async function parentExists(id: number): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM posts WHERE id = $1`, [id]);
  return res.rows.length > 0;
}

function sanitizeText(text: string): string | null {
  const t = (text || "").trim();
  if (t.length === 0) return null;
  if (t.length > MAX_TEXT) return t.slice(0, MAX_TEXT).trim();
  return t;
}

/** 決定のアクションを検証して実行する。
 *  dry: 実際には投稿しない。
 *  responded: 既に反応済みの投稿ID（同一投稿への再返信をハードにスキップ）。
 *  replyLimit: この tick で実行する返信の上限（明示メンション数に応じて拡張）。
 *  返り値 repliedTo: 実際に（または dry でなら想定して）返信した親投稿ID（記録用）。 */
export async function applyActions(
  decision: BeagleDecision,
  dry: boolean,
  responded?: Set<number>,
  replyLimit: number = MAX_REPLIES
): Promise<{ postedIds: number[]; skipped: { type: string; reason: string }[]; repliedTo: number[] }> {
  const postedIds: number[] = [];
  const skipped: { type: string; reason: string }[] = [];
  const repliedTo: number[] = [];
  if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
    return { postedIds, skipped, repliedTo };
  }

  // 種別ごとのキャップ（introduce は post と同枠で root 投稿扱い）
  const posts = decision.actions
    .filter((a) => a.type === "post" || a.type === "introduce")
    .slice(0, MAX_POSTS);
  const replies = decision.actions.filter((a) => a.type === "reply").slice(0, replyLimit);
  const plan: BeagleAction[] = [...posts, ...replies];

  for (const a of plan) {
    const text = sanitizeText(a.text);
    if (!text) {
      skipped.push({ type: a.type, reason: "empty" });
      continue;
    }
    if (a.type === "reply") {
      if (!a.parentId || !(await parentExists(a.parentId))) {
        skipped.push({ type: "reply", reason: `invalid parent ${a.parentId}` });
        continue;
      }
      if (responded && responded.has(a.parentId)) {
        skipped.push({ type: "reply", reason: `already_responded ${a.parentId}` });
        continue;
      }
      repliedTo.push(a.parentId);
      if (dry) continue;
      const p = await createPost({
        authorEmail: SYSTEM_EMAIL,
        authorName: SYSTEM_NAME,
        text,
        parentId: a.parentId,
      });
      postedIds.push(p.id);
    } else if (a.type === "introduce") {
      // 紹介対象が今も未紹介（更新が最新）のときだけ導入する
      const awaiting = await pool.query(
        `SELECT 1 FROM user_profiles u
          WHERE u.email = $1
            AND u.updated_at > now() - interval '30 days'
            AND ( NOT EXISTS (SELECT 1 FROM beagle_profile_intros b WHERE b.email = u.email)
                  OR u.updated_at > (SELECT MAX(b.introduced_at)
                                      FROM beagle_profile_intros b WHERE b.email = u.email) )`,
        [a.email]
      );
      if (awaiting.rows.length === 0) {
        skipped.push({ type: "introduce", reason: `not awaiting ${a.email}` });
        continue;
      }
      if (dry) continue;
      const p = await createPost({
        authorEmail: SYSTEM_EMAIL,
        authorName: SYSTEM_NAME,
        text,
      });
      postedIds.push(p.id);
      // 紹介済みとして記録（次回から同一更新への再紹介を防ぐ）
      await pool.query(
        `INSERT INTO beagle_profile_intros (email) VALUES ($1)
         ON CONFLICT (email) DO UPDATE SET introduced_at = now()`,
        [a.email]
      );
    } else {
      if (dry) continue;
      const p = await createPost({
        authorEmail: SYSTEM_EMAIL,
        authorName: SYSTEM_NAME,
        text,
      });
      postedIds.push(p.id);
    }
  }
  return { postedIds, skipped, repliedTo };
}

/** ニュース投稿済みURLを memory 形式で返す（dedup 用に直接 call されることは少ない）。 */
export function newsUrlFromText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)\]"'<>]+/);
  return m ? m[0] : null;
}
