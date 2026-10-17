/** 部活の表示順（クライアント・サーバー共用の純粋関数。DB に触れない）。
 *
 * 1. ピン留めした部活（snize 2026-10-17 要望「位置を固定して、都度探したくない」）
 *    — ピンした順（pinned は pinned_at 昇順で渡される）。カタログに無い
 *    （削除・非アクティブ化された）キーは落とす。
 * 2. 残り — 活性度（直近7日アクティビティ）降順、同数ならカタログ順（安定ソート）。
 *
 * 左サイドバー・モバイル部活バー・Shift+Option+↑↓ の部活移動が全部これを使う。 */
export function orderClubKeys(
  catalogKeys: readonly string[],
  activity: Readonly<Record<string, number>>,
  pinned: readonly string[] = [],
): string[] {
  const inCatalog = new Set(catalogKeys);
  const pins: string[] = [];
  for (const k of pinned) {
    if (inCatalog.has(k) && !pins.includes(k)) pins.push(k);
  }
  const pinSet = new Set(pins);
  const rest = catalogKeys
    .filter((k) => !pinSet.has(k))
    .sort((a, b) => (activity[b] ?? 0) - (activity[a] ?? 0));
  return [...pins, ...rest];
}
