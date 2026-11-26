/* NG ワード（本人の設定、Web とアプリ共通。drikin 2026-10-29）。
 * 言葉を含むほかの人の投稿・返信は、その人のタイムライン・検索・スレッドに出ない（自分の投稿は出る）。
 * 隠れる投稿への返信・メンション・新着の知らせも作らない。チャットと DM はそのまま。
 * 大文字小文字・全角半角は区別しない（JS も SQL も NFKC + 小文字で比べる）。 */
import { pool } from "./db";

/* 人のミュート（drikin 2026-11-25「タイムラインに表示したくない人をミュートできるようにする」）。
 * NG ワードと同じ場所・同じ決まりで効く: その人の投稿・返信がタイムライン・検索・スレッドに出ず、
 * 知らせ（返信・メンション・新着 push・NEW）も来ない。チャット・DM はそのまま。相手には知らせない。
 * その人のプロフィールを開いたときだけは出す（自分で見に行ったので）。
 * 絞り込みの配列には言葉と一緒に「\u0001 + メール」の形で入る（言葉には制御文字を入れさせない）ので、
 * 今までの呼び出し元（getMutedWords → noMutedWordSql）はそのまま人のミュートにも効く。 */
export const MUTED_USER_PREFIX = "\u0001";
export const MAX_MUTED_USERS = 500;

export function mutedUserToken(email: string): string {
  return MUTED_USER_PREFIX + email.trim().toLowerCase();
}

export function isMutedUserToken(t: string): boolean {
  return t.startsWith(MUTED_USER_PREFIX);
}

export const MAX_MUTED_WORDS = 50;
export const MAX_MUTED_WORD_LENGTH = 40;

/** 比べる形: NFKC・小文字・前後の空白を落として、中の空白は 1 つに。 */
export function normalizeMutedWord(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

/** 言葉だけ（設定の画面に出す一覧）。 */
async function getWordsOnly(email: string): Promise<string[]> {
  if (!email) return [];
  const r = await pool.query(`SELECT word FROM muted_words WHERE email = $1 ORDER BY created_at, word`, [email]);
  return r.rows.map((x) => x.word as string);
}

/** 絞り込みに渡す配列: NG ワードと、ミュートした人（mutedUserToken の形）。 */
export async function getMutedWords(email: string): Promise<string[]> {
  if (!email) return [];
  const r = await pool.query(
    `SELECT word FROM (SELECT word, created_at FROM muted_words WHERE email = $1
       UNION ALL SELECT $2 || muted_email, created_at FROM muted_users WHERE email = $1) x
     ORDER BY created_at, word`,
    [email, MUTED_USER_PREFIX]
  );
  return r.rows.map((x) => x.word as string);
}

/** ミュートした人のメール（登録順）。 */
export async function getMutedUserEmails(email: string): Promise<string[]> {
  if (!email) return [];
  const r = await pool.query(`SELECT muted_email FROM muted_users WHERE email = $1 ORDER BY created_at`, [email]);
  return r.rows.map((x) => x.muted_email as string);
}

export async function isUserMuted(email: string, target: string): Promise<boolean> {
  if (!email || !target) return false;
  const r = await pool.query(`SELECT 1 FROM muted_users WHERE email = $1 AND muted_email = $2`, [email, target.toLowerCase()]);
  return r.rows.length > 0;
}

/** ミュートする・外す。自分はミュートできない。上限は安全弁。 */
export async function setUserMuted(email: string, target: string, muted: boolean): Promise<{ ok: true } | MutedWordsError> {
  const t = target.trim().toLowerCase();
  if (!email || !t) return { error: "ユーザーが見つかりません" };
  if (t === email.toLowerCase()) return { error: "自分はミュートできません" };
  if (!muted) {
    await pool.query(`DELETE FROM muted_users WHERE email = $1 AND muted_email = $2`, [email, t]);
    return { ok: true };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('muted_users:' || $1))", [email]);
    const n = await client.query(`SELECT count(*)::int AS n FROM muted_users WHERE email = $1`, [email]);
    if (n.rows[0].n >= MAX_MUTED_USERS) {
      await client.query("ROLLBACK");
      return { error: `ミュートできるのは ${MAX_MUTED_USERS} 人までです` };
    }
    await client.query(`INSERT INTO muted_users (email, muted_email) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [email, t]);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { ok: true };
}

/** 設定の一覧に出すミュートした人（名前とアイコン。メールは出さない）。 */
export async function listMutedUsers(email: string): Promise<{ userId: string; name: string; avatar: string | null }[]> {
  const emails = await getMutedUserEmails(email);
  if (emails.length === 0) return [];
  const { ensureUserId } = await import("./user");
  const { getProfile } = await import("./profile");
  const out: { userId: string; name: string; avatar: string | null }[] = [];
  for (const e of emails) {
    const p = await getProfile(e).catch(() => null);
    out.push({ userId: p?.userId ?? (await ensureUserId(e)), name: p?.name || "（名前なし）", avatar: p?.avatar ?? null });
  }
  return out;
}

export type MutedWordsError = { error: string };

/** 言葉の一覧をそろえる（正規化・重複を落とす・上限）。だめなら理由を返す。 */
export function cleanMutedWords(input: unknown): string[] | MutedWordsError {
  if (!Array.isArray(input)) return { error: "words は文字列の配列です" };
  const out: string[] = [];
  for (const w of input) {
    if (typeof w !== "string") return { error: "words は文字列の配列です" };
    const n = normalizeMutedWord(w);
    if (!n) continue;
    if ([...n].length > MAX_MUTED_WORD_LENGTH) return { error: `NG ワードは ${MAX_MUTED_WORD_LENGTH} 文字までです` };
    if (!out.includes(n)) out.push(n);
  }
  if (out.length > MAX_MUTED_WORDS) return { error: `NG ワードは ${MAX_MUTED_WORDS} 個までです` };
  return out;
}

/** 一覧ごと置き換える（足す・消すはアプリ側で一覧を直して送る）。前からある言葉は登録日を保つ。 */
export async function setMutedWords(email: string, words: string[]): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 同じ人の保存は 1 つずつ（同時の 2 回で一覧の和が残り、上限を超えないように）。
    await client.query("SELECT pg_advisory_xact_lock(hashtext('muted_words:' || $1))", [email]);
    await client.query(`DELETE FROM muted_words WHERE email = $1 AND NOT (word = ANY($2::text[]))`, [email, words]);
    for (const w of words) {
      await client.query(`INSERT INTO muted_words (email, word, created_at) VALUES ($1, $2, clock_timestamp()) ON CONFLICT DO NOTHING`, [email, w]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return getWordsOnly(email);
}

/** SQL: 本文を比べる形に（NFKC・小文字・空白を 1 つに）。言葉の側（normalizeMutedWord）と同じ。 */
function normalizedTextSql(textExpr: string): string {
  return `regexp_replace(lower(normalize(COALESCE(${textExpr}, ''), NFKC)), '\\s+', ' ', 'g')`;
}

/** SQL: `textExpr` が `wordsParam`（text[]）のどれも含まない。本文の正規化は 1 行 1 回（OFFSET 0 で
 *  言葉ごとに計算し直させない。50 語・1.2 万件で 1.7 秒 → 0.1 秒、レビューで計測）。 */
export function noMutedWordSql(textExpr: string, wordsParam: string, authorExpr?: string): string {
  // 人のミュート（\u0001 + メール）は投稿者で比べる。呼び出し元はどれも <別名>.text を渡す。
  const author = authorExpr ?? textExpr.replace(/\.text$/, ".author_email");
  if (author === textExpr) throw new Error(`noMutedWordSql: author column unknown for ${textExpr}`);
  return `NOT EXISTS (SELECT 1 FROM (SELECT ${normalizedTextSql(textExpr)} AS t, lower(${author}) AS a OFFSET 0) mt, unnest(${wordsParam}::text[]) mw WHERE CASE WHEN left(mw, 1) = chr(1) THEN mt.a = substr(mw, 2) ELSE strpos(mt.t, mw) > 0 END)`;
}

/** JS 側の同じ判定（テストと、すでに読んだ本文に使う）。 */
export function containsMutedWord(text: string, words: string[]): boolean {
  const ws = words.filter((w) => !isMutedUserToken(w));
  if (ws.length === 0) return false;
  const t = text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");
  return ws.some((w) => t.includes(w));
}

/** この人に、これらの投稿（またはその親の投稿）が NG ワードで隠れるか。知らせを作る前に使う。
 *  自分の投稿は隠れない。 */
export async function isMutedFor(email: string, postIds: (number | null | undefined)[]): Promise<boolean> {
  const ids = postIds.filter((n): n is number => Number.isInteger(n));
  if (!email || ids.length === 0) return false;
  const words = await getMutedWords(email);
  if (words.length === 0) return false;
  const r = await pool.query(
    `SELECT 1 FROM posts p
      WHERE (p.id = ANY($2::int[]) OR p.id IN (SELECT parent_id FROM posts WHERE id = ANY($2::int[]) AND parent_id IS NOT NULL))
        AND p.author_email <> $1
        AND NOT (${noMutedWordSql("p.text", "$3")})
      LIMIT 1`,
    [email, ids, words]
  );
  return r.rows.length > 0;
}

/** この投稿が NG ワードか人のミュートで隠れる人（`emails` のうち）。新着の知らせを送る前に使う。投稿者は含めない。 */
export async function mutedRecipients(postId: number, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const r = await pool.query(
    `SELECT DISTINCT mw.email FROM muted_words mw JOIN posts p ON p.id = $1
      WHERE mw.email = ANY($2::text[]) AND mw.email <> p.author_email
        AND strpos(${normalizedTextSql("p.text")}, mw.word) > 0
     UNION
     SELECT mu.email FROM muted_users mu JOIN posts p ON p.id = $1
      WHERE mu.email = ANY($2::text[]) AND mu.muted_email = lower(p.author_email)`,
    [postId, emails]
  );
  return new Set(r.rows.map((x) => x.email as string));
}

type Out = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

/** アプリの窓口 GET → { apiVersion, words, max, maxLength, users: [{ user_id, name, avatar }] } */
export async function getMutedWordsApi(email: string): Promise<Out> {
  const users = (await listMutedUsers(email)).map((u) => ({ user_id: u.userId, name: u.name, avatar: u.avatar }));
  return {
    status: 200,
    body: { apiVersion: 1, words: await getWordsOnly(email), max: MAX_MUTED_WORDS, maxLength: MAX_MUTED_WORD_LENGTH, users },
    headers: {},
  };
}

/** POST/DELETE …/users/:id/mute の中身 → { apiVersion, muted } */
export async function setUserMutedApi(email: string, targetUserId: string, muted: boolean): Promise<Out> {
  const { userIdToEmail } = await import("./user");
  const target = /^[A-Za-z0-9_-]{4,64}$/.test(targetUserId) ? await userIdToEmail(targetUserId) : null;
  if (!target) return { status: 404, body: { error: "ユーザーが見つかりません", code: "not_found" }, headers: {} };
  const r = await setUserMuted(email, target, muted);
  if ("error" in r) return { status: 400, body: { error: r.error, code: "invalid_request" }, headers: {} };
  return { status: 200, body: { apiVersion: 1, muted }, headers: {} };
}

/** アプリの窓口 PUT { words: [...] }（一覧ごと置き換え）→ { apiVersion, words }（そろえた形） */
export async function setMutedWordsApi(email: string, body: Record<string, unknown>): Promise<Out> {
  const words = cleanMutedWords(body.words);
  if (!Array.isArray(words)) return { status: 400, body: { error: words.error, code: "invalid_request" }, headers: {} };
  return { status: 200, body: { apiVersion: 1, words: await setMutedWords(email, words) }, headers: {} };
}
