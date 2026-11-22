/**
 * 📜 台本（単独の機能、2026-11-14 オーナー「オリジナルのネタ帳にあった台本機能を単独で B-guru に」）。
 * - 読めるのは有料会員（B-guru のログイン、またはアプリのタブのログイン）。直すのは管理者（出演者）だけ。
 * - 台本の中身は neta_scripts（ネタ帳の週ごと）。ネタ帳の管理画面の台本と同じもの。
 * - 2 人が同時に直しても消し合わないように、保存は「読んだときの版」と比べる（違えば 409 で相手の版を返す）。
 *   チェック欄の切り替えはサーバで 1 か所だけ書き換える（同時に押しても両方残る）。
 */
import { pool } from "./db";
import { isAdmin } from "./admin";
import { resolveDisplayName } from "./display-name";
import { getNetaViewer } from "./neta-auth";
import { ensureScript, NETA_SCRIPT_MAX } from "./neta-admin";
import { countChecks, toggleNthCheck } from "./neta-script";
import { NetaError } from "./neta-write";

export type ScriptDoc = { content: string; updatedBy: string | null; updatedAt: string };
export type ScriptWeek = { id: number; title: string; isActive: boolean; hasScript: boolean; featured: number };

/** 有料会員なら { email, admin }、そうでなければ null。 */
export async function scriptViewer(): Promise<{ email: string; admin: boolean } | null> {
  const v = await getNetaViewer().catch(() => null);
  if (!v || v.tier !== "paid") return null;
  return { email: v.email, admin: isAdmin(v.email) };
}

/** 保存した人の名前（メールアドレスは出さない）: B-guru のプロフィールの名前、なければメールの @ の前。 */
async function editorName(email: string): Promise<string> {
  const n = String((await resolveDisplayName(email).catch(() => null)) ?? "").trim();
  return n && !n.includes("@") ? n.slice(0, 40) : email.split("@")[0];
}

const toDoc = (x: { content: unknown; updated_by: unknown; updated_at: unknown }): ScriptDoc => ({
  content: String(x.content),
  updatedBy: x.updated_by == null ? null : String(x.updated_by),
  updatedAt: new Date(x.updated_at as string).toISOString(),
});

export async function scriptWeeks(): Promise<ScriptWeek[]> {
  const r = await pool.query(
    `SELECT w.id, w.title, w.is_active, (s.week_id IS NOT NULL) AS has_script,
            (SELECT count(*)::int FROM neta_topics t WHERE t.week_id = w.id AND t.status = 'featured') AS featured
       FROM neta_weeks w LEFT JOIN neta_scripts s ON s.week_id = w.id ORDER BY w.id DESC LIMIT 60`
  );
  return r.rows.map((x) => ({ id: Number(x.id), title: String(x.title), isActive: x.is_active === true, hasScript: x.has_script === true, featured: Number(x.featured) }));
}

export async function readScript(weekId: number): Promise<ScriptDoc | null> {
  await ensureScript(weekId).catch((e) => console.error("[script] ensureScript failed:", (e as Error)?.message));
  const r = await pool.query(`SELECT content, updated_by, updated_at FROM neta_scripts WHERE week_id = $1`, [weekId]);
  return r.rows[0] ? toDoc(r.rows[0]) : null;
}

/**
 * 保存。base は読んだときの updatedAt（台本がまだなかったなら null）。今の版と違えば 409（extra.script に今の版）。
 * 上書きしたいときは、相手の版の updatedAt を base にして送り直す。
 */
export async function saveScriptVersioned(weekId: number, content: unknown, base: unknown, email: string): Promise<ScriptDoc> {
  if (typeof content !== "string" || !content.trim()) throw new NetaError(400, "台本が空です");
  if (content.length > NETA_SCRIPT_MAX) throw new NetaError(400, "台本が長すぎます");
  if (base !== null && (typeof base !== "string" || Number.isNaN(Date.parse(base)))) throw new NetaError(400, "版の指定が不正です");
  const w = await pool.query(`SELECT 1 FROM neta_weeks WHERE id = $1`, [weekId]);
  if (!w.rows[0]) throw new NetaError(404, "週が見つかりません");
  const by = await editorName(email);
  const r =
    base === null
      ? await pool.query(
          `INSERT INTO neta_scripts (week_id, content, updated_by, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (week_id) DO NOTHING RETURNING content, updated_by, updated_at`,
          [weekId, content, by]
        )
      : await pool.query(
          // JS の日時はミリ秒までなので、ミリ秒で比べる。
          `UPDATE neta_scripts SET content = $2, updated_by = $3, updated_at = now()
            WHERE week_id = $1 AND date_trunc('milliseconds', updated_at) = $4::timestamptz RETURNING content, updated_by, updated_at`,
          [weekId, content, by, base]
        );
  if (r.rows[0]) return toDoc(r.rows[0]);
  const now = await readScript(weekId);
  throw new NetaError(409, now ? `${now.updatedBy ?? "ほかの人"}さんが先に保存しました` : "台本が消されています", "conflict", { script: now });
}

/** n 番目のチェック欄を切り替える（管理者）。 */
export async function toggleScriptCheck(weekId: number, n: unknown, email: string): Promise<ScriptDoc> {
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 10_000) throw new NetaError(400, "チェックの指定が不正です");
  const by = await editorName(email);
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(`SELECT content FROM neta_scripts WHERE week_id = $1 FOR UPDATE`, [weekId]);
    if (!r.rows[0]) throw new NetaError(404, "台本がありません");
    const next = toggleNthCheck(String(r.rows[0].content), n);
    if (next === null) throw new NetaError(409, "台本が変わりました。読み直してください", "stale");
    const u = await c.query(
      `UPDATE neta_scripts SET content = $2, updated_by = $3, updated_at = now() WHERE week_id = $1 RETURNING content, updated_by, updated_at`,
      [weekId, next, by]
    );
    await c.query("COMMIT");
    return toDoc(u.rows[0]);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export { countChecks };
