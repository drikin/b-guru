import { CLUB_UNSET } from "./club-catalog";

/** 通知から投稿へ飛ぶとき、どの部活フィルタで表示すれば投稿が見えるか（純関数）。
 *
 * リュー 2026-10-16 要望: 部活で絞り込み中に別の部活の通知を押しても何も起きない。
 * - いま見ている部活の投稿なら、そのまま（絞り込みを崩さない）。
 * - 目玉で隠した部活の投稿は「すべて」にも出ないので、その部活に切り替える
 *   （?club= 指定時はサーバーが非表示設定を適用しない）。
 * - それ以外は「すべて」(null)。未分類（club=NULL）の投稿は常に「すべて」に出る。
 *
 * rootClub が active な部活でない（削除済み・__unset__）投稿は「未設定」枠として扱う
 * （サーバーの非表示 SQL と同じ切り分け）。 */
export function notifJumpClub(
  current: string | null,
  rootClub: string | null,
  activeKeys: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): string | null {
  const bucket = rootClub == null ? null : activeKeys.has(rootClub) ? rootClub : CLUB_UNSET;
  if (current !== null && bucket === current) return current;
  if (bucket !== null && hidden.has(bucket)) return bucket;
  return null;
}
