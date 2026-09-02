/**
 * キーボードナビゲーション（JK/NP）の移動ロジック。
 *
 * J/K は全カード（コメント含む）、N/P は親（ルート）カードのみを走査する。
 * どちらも「次のIDを計算する」部分は同一構造なので、純粋関数として抽出し
 * 回帰テストで保護する。DOM や React state に依存しない。
 *
 * 仕様（page.tsx の move / moveParent と一致させること）:
 * - cursorId が null（未選択）→ 常に先頭（ids[0]）から開始。
 * - cursorId が ids に含まれない → dir===1 なら先頭、dir===-1 なら末尾。
 * - dir===1（次へ）→ i+1 < len なら ids[i+1]、末尾なら ids[i]（クランプ、ラップしない）。
 * - dir===-1（前へ）→ i-1 >= 0 なら ids[i-1]、先頭なら ids[i]（クランプ、ラップしない）。
 */

export type KbdDir = 1 | -1;

/**
 * 現在のカーソル位置から、次の移動先のカードIDを計算する。
 *
 * @param ids   走査対象のカードID配列（DOM順）。J/K は全カード、N/P は親カードのみ。
 * @param cursorId 現在のカーソル位置のカードID。null なら未選択。
 * @param dir   移動方向。1=次へ、-1=前へ。
 * @returns 次の移動先のカードID。ids が空なら null。
 */
export function computeNextKbdId(
  ids: number[],
  cursorId: number | null,
  dir: KbdDir,
): number | null {
  if (ids.length === 0) return null;

  // 未選択（カーソルなし）: どちらの方向でも先頭から開始。
  if (cursorId == null) return ids[0];

  const i = ids.indexOf(cursorId);
  if (i < 0) {
    // カーソルが走査対象に含まれない（例: フィード再読込で消えた）→ 方向に応じて端へ。
    return dir === 1 ? ids[0] : ids[ids.length - 1];
  }

  if (dir === 1) {
    // 次へ。末尾でクランプ（ラップしない）。ページネーションで新しいカードが
    // 末尾に追記されるのを待つため、末尾で止める。
    return i + 1 < ids.length ? ids[i + 1] : ids[i];
  }
  // 前へ。先頭でクランプ（ラップしない）。
  return i - 1 >= 0 ? ids[i - 1] : ids[i];
}
