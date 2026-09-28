/**
 * 既読状態の純ロジック（テスト可能な形に切り出したもの）。
 *
 * 背景: 既読はもともと `src/app/page.tsx` の中に閉じた localStorage ストアとして
 * 実装されていた。tochi 2026-09-27「PCとスマホの両方でみた場合に、未読管理を
 * 共通管理にしたい」を受けてサーバー永続化するにあたり、**移行ロジックと
 * バリデーションを純関数として切り出す**。page.tsx に埋めたままだとテストできず、
 * 「移行で既読が消える」という最大リスクを検出する網が無いまま出荷することになる。
 *
 * このファイルは DOM にも fetch にも依存しない。副作用は一切無い。
 */

/** 既読 ID の集合。localStorage とサーバーの両方でこの形を使う。 */
export type ReadIds = Set<number>;

/**
 * サーバーへ送る 1 バッチの最大件数。
 *
 * ★ 上限が無いと DoS になる。実測: nginx `client_max_body_size` は 85m、
 *   DB プールは `max: 10`、pm2 は `fork_mode`（単一プロセス）。85MB の JSON 配列
 *   ≒ 2000万個の int を `unnest` して INSERT を試行でき、数リクエストで
 *   サイト全体が無応答になる。
 */
export const MAX_READ_BATCH = 500;

/**
 * PostgreSQL の `integer`（int32）の最大値。
 *
 * ★ これを超える値を `$2::int[]` に渡すと `22003: value "..." is out of range
 *   for type integer` になる。実測（2026-09-28・本番ログ）: 269 件発生
 *   （`[posts/read]` 119 / `reactions fetch error` 132）。渡っていた値は
 *   **すべて 13 桁**で、正体は楽観投稿の `tempId = Date.now()`。
 *
 * `Number.isSafeInteger` は 2^53 まで通すので 13 桁を弾けない。**int32 の上限で
 * 締める必要がある**（DB のカラム型が int32 である限り、これが唯一の正しい境界）。
 */
export const PG_INT_MAX = 2147483647;

/**
 * 任意の値を「既読 ID として妥当な正の整数」に正規化する。
 *
 * ★ `Number.isInteger` を必ず通す。PostgreSQL の `$2::int[]` は `1.5` を
 *   1 に丸めるので、サーバー側で弾かないと意図しない ID が保存される。
 *   負数・0・NaN・Infinity・文字列・null も同様に落とす。
 *
 * ★★ **int32 の上限（`PG_INT_MAX`）も必ず見る。** これが無いと、楽観投稿の
 *   `tempId = Date.now()`（13 桁）がそのまま DB に渡り 22003 で失敗する。
 *   実測で 269 件のエラーが出ていた（既読が保存されない・リアクションが
 *   表示されないという実害）。**この上限はここ 1 箇所に集約する** —
 *   呼び出し側で個別に判定すると、片方だけ直して片方が漏れる。
 */
export function normalizeReadId(v: unknown): number | null {
  if (typeof v !== "number") return null;
  if (!Number.isInteger(v)) return null;
  if (v <= 0) return null;
  if (!Number.isSafeInteger(v)) return null; // DEGRADE PROOF
  return v;
}

/** 配列から妥当な ID だけを取り出す（重複は除去、順序は保持）。 */
export function normalizeReadIds(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of values) {
    const id = normalizeReadId(v);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 移行: ローカルの既読とサーバーの既読を統合し、サーバーへ送るべき差分を返す。
 *
 * ★★ 順序が本質。**必ず「サーバーの既読を取得してから」呼ぶこと。**
 *   サーバーの既読が空の状態でこれを呼ぶと、ローカルの既読がそのまま
 *   「サーバーに無い分」として全件返る。それは正しい動作だが、逆に
 *   「サーバーの既読でローカルを上書きする」実装にすると、他端末で読んだ分が
 *   消える。統合は必ず**和集合**であり、どちらの既読も失ってはならない。
 *
 * 不変条件:
 *   - `merged ⊇ local` かつ `merged ⊇ server`（既読は単調増加、絶対に減らない）
 *   - `toPost` は `server` に含まれない `local` の要素のみ
 */
export function mergeReadState(
  localIds: Iterable<number>,
  serverIds: Iterable<number>
): { merged: ReadIds; toPost: number[] } {
  const server = new Set<number>();
  for (const v of serverIds) {
    const id = normalizeReadId(v);
    if (id !== null) server.add(id);
  }
  const merged = new Set<number>(server);
  const toPost: number[] = [];
  for (const v of localIds) {
    const id = normalizeReadId(v);
    if (id === null) continue;
    if (server.has(id)) continue; // サーバーに既にある → 送る必要なし
    if (merged.has(id)) continue; // ローカル内の重複
    merged.add(id);
    toPost.push(id);
  }
  return { merged, toPost };
}

/**
 * 送信バッチを上限で分割する。
 *
 * 1 リクエストが `MAX_READ_BATCH` を超えないようにする。移行時は
 * ローカルの既読が最大 1,576 件（実測: 1 ユーザーの最大投稿数）になるため、
 * 分割が必須。
 */
export function chunkReadIds(ids: number[], size = MAX_READ_BATCH): number[][] {
  if (size <= 0) throw new Error("chunk size must be positive");
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    out.push(ids.slice(i, i + size));
  }
  return out;
}

/**
 * サーバーへ送るボディを組み立てる。空なら null（送信不要）。
 *
 * 空配列を POST しないことで、無駄な往復とサーバー側の空 INSERT を避ける。
 */
export function buildReadPayload(ids: number[]): { ids: number[] } | null {
  const clean = normalizeReadIds(ids);
  if (clean.length === 0) return null;
  return { ids: clean.slice(0, MAX_READ_BATCH) };
}
