/* ビーグルエージェント: 実行（ビーグル名義で投稿/コメント） */
import { createPost } from "../posts";
import { pool } from "../db";
import { SYSTEM_EMAIL, SYSTEM_NAME } from "./store";
import type { BeagleAction, BeagleDecision } from "./types";

const MAX_TEXT = 1500;
const MAX_POSTS = 2;
const MAX_REPLIES = 3;

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

/** 決定のアクションを検証して実行する。dry なら実行しない。 */
export async function applyActions(
  decision: BeagleDecision,
  dry: boolean
): Promise<{ postedIds: number[]; skipped: { type: string; reason: string }[] }> {
  const postedIds: number[] = [];
  const skipped: { type: string; reason: string }[] = [];
  if (!Array.isArray(decision.actions) || decision.actions.length === 0) {
    return { postedIds, skipped };
  }

  // 種別ごとのキャップ
  const posts = decision.actions.filter((a) => a.type === "post").slice(0, MAX_POSTS);
  const replies = decision.actions.filter((a) => a.type === "reply").slice(0, MAX_REPLIES);
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
      if (dry) continue;
      const p = await createPost({
        authorEmail: SYSTEM_EMAIL,
        authorName: SYSTEM_NAME,
        text,
        parentId: a.parentId,
      });
      postedIds.push(p.id);
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
  return { postedIds, skipped };
}

/** ニュース投稿済みURLを memory 形式で返す（dedup 用に直接 call されることは少ない）。 */
export function newsUrlFromText(text: string): string | null {
  const m = text.match(/https?:\/\/[^\s)\]"'<>]+/);
  return m ? m[0] : null;
}
