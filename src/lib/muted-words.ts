/* NG ワード（本人の設定、Web とアプリ共通。drikin 2026-10-29）。
 * 言葉を含むほかの人の投稿・返信は、その人のタイムライン・検索・スレッドに出ない（自分の投稿は出る）。
 * 隠れる投稿への返信・メンション・新着の知らせも作らない。チャットと DM はそのまま。
 * 大文字小文字・全角半角は区別しない（JS も SQL も NFKC + 小文字で比べる）。 */
import { pool } from "./db";

export const MAX_MUTED_WORDS = 50;
export const MAX_MUTED_WORD_LENGTH = 40;

/** 比べる形: NFKC・小文字・前後の空白を落として、中の空白は 1 つに。 */
export function normalizeMutedWord(raw: string): string {
  return raw.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function getMutedWords(email: string): Promise<string[]> {
  if (!email) return [];
  const r = await pool.query(`SELECT word FROM muted_words WHERE email = $1 ORDER BY created_at, word`, [email]);
  return r.rows.map((x) => x.word as string);
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
  return getMutedWords(email);
}

/** SQL: `textExpr` が `wordsParam`（text[]）のどれも含まない。 */
export function noMutedWordSql(textExpr: string, wordsParam: string): string {
  return `NOT EXISTS (SELECT 1 FROM unnest(${wordsParam}::text[]) mw WHERE strpos(lower(normalize(COALESCE(${textExpr}, ''), NFKC)), mw) > 0)`;
}

/** JS 側の同じ判定（テストと、すでに読んだ本文に使う）。 */
export function containsMutedWord(text: string, words: string[]): boolean {
  if (words.length === 0) return false;
  const t = text.normalize("NFKC").toLowerCase();
  return words.some((w) => t.includes(w));
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

/** この投稿が NG ワードで隠れる人（`emails` のうち）。新着の知らせを送る前に使う。投稿者は含めない。 */
export async function mutedRecipients(postId: number, emails: string[]): Promise<Set<string>> {
  if (emails.length === 0) return new Set();
  const r = await pool.query(
    `SELECT DISTINCT mw.email FROM muted_words mw JOIN posts p ON p.id = $1
      WHERE mw.email = ANY($2::text[]) AND mw.email <> p.author_email
        AND strpos(lower(normalize(COALESCE(p.text, ''), NFKC)), mw.word) > 0`,
    [postId, emails]
  );
  return new Set(r.rows.map((x) => x.email as string));
}

type Out = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

/** アプリの窓口 GET → { apiVersion, words, max, maxLength } */
export async function getMutedWordsApi(email: string): Promise<Out> {
  return {
    status: 200,
    body: { apiVersion: 1, words: await getMutedWords(email), max: MAX_MUTED_WORDS, maxLength: MAX_MUTED_WORD_LENGTH },
    headers: {},
  };
}

/** アプリの窓口 PUT { words: [...] }（一覧ごと置き換え）→ { apiVersion, words }（そろえた形） */
export async function setMutedWordsApi(email: string, body: Record<string, unknown>): Promise<Out> {
  const words = cleanMutedWords(body.words);
  if (!Array.isArray(words)) return { status: 400, body: { error: words.error, code: "invalid_request" }, headers: {} };
  return { status: 200, body: { apiVersion: 1, words: await setMutedWords(email, words) }, headers: {} };
}
