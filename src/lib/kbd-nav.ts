/**
 * キーボードナビゲーション（JK/NP）の移動ロジック。
 *
 * J/K は全カード（コメント含む）、N/P は親（ルート）カードのみを走査する。
 * どちらも「次の移動先のIDを計算する」部分は同一構造なので、純粋関数として
 * 抽出し回帰テストで保護する。DOM や React state に依存しない。
 *
 * 仕様（page.tsx の move / moveParent と一致させること）:
 * - cursorId が null（未選択）→ 常に先頭（ids[0]）から開始。
 * - cursorId が ids に含まれる → その位置から dir 方向へ1つ（端でクランプ）。
 * - cursorId が ids に含まれない → **DOM順で最も近い対象へ直接着地**する。
 * - 端ではクランプ（ラップしない）。
 *
 * ## 位置同期（2026-09-15・kai3desu フィードバック対応）
 *
 * J/K と N/P は**同じカーソルを共有**する（別々に記憶しない）。ユーザー要望は
 * 「N/P を押したら J/K の位置も動く」＝両者をシームレスに繋ぐこと。
 *
 * 旧実装は「カーソルが走査対象に無い → 方向に応じて先頭/末尾へ」だったため、
 * **J/K でコメント上にいる状態で N を押すと先頭（TOP）へ飛んでいた**
 * （kai3desu 報告: 「NでここはJで読もうかなと思うとTOPもどっちゃう」）。
 *
 * 新実装は「カーソルが対象リストのどの位置に挟まるか」を **DOM順の全カード列**
 * から解決し、その位置の対象へ**直接着地**する。ID の大小では解決できない点に
 * 注意: B-guru のフィードは `last_activity DESC` 順（コメントが付いた古い投稿が
 * 上に浮上する）なので、**DOM順 ≠ ID順**。したがって位置解決には
 * 「全カードの DOM 順リスト」と「対象リスト」の両方が必要。
 *
 * ## 既知の制限（意図的・PEレビュー指摘 2026-09-15）
 *
 * **フィード最端（最初の親より上 / 最後の親より下）のコメント位置は保持されない。**
 * 例: DOM `[50親, 51コメント, 900親, 901コメント]` で 901 に N を押すと、901 より
 * 後ろに親が無いので末尾の親 900 にクランプする。その後 K を押すと 900 の前の
 * カード（51）へ進み、901 には戻らない。
 *
 * これは「カーソルは今 900 にあり、K は 900 の前へ」という一貫した動作であり、
 * ラップ回避（端でクランプ）の帰結として正しい。最端では「次/前の親が存在しない」
 * ため、サブ位置（コメント）を保持する先が無い。**仕様として許容する**
 * （テスト `位置同期: 最端のクランプ` で固定）。
 */

export type KbdDir = 1 | -1;

/**
 * カーソル位置を、対象リスト内の「DOM順で最も近い位置」に解決する。
 *
 * @param ids        走査対象のカードID配列（DOM順）。
 * @param cursorId   現在のカーソル位置のカードID。
 * @param dir        移動方向。
 * @param allIds     メイン列の**全カード**の DOM 順リスト（位置解決の基準）。
 *                   省略時は `ids` 自身を基準にする。
 *
 * 戻り値は「着地すべき対象の index」。カーソルが `ids` に含まれる場合は
 * その index をそのまま返す（呼び出し側が dir 方向へ1つ進める）。
 * 含まれない場合は、`allIds` 上でのカーソル位置を基準に:
 * - 次へ（dir=1）: `ids` のうち **allIds 上でカーソルより後ろ**にある最初の要素。
 * - 前へ（dir=-1）: `ids` のうち **allIds 上でカーソルより前**にある最後の要素。
 * 該当が無ければ端（次へ=末尾 / 前へ=先頭）にクランプする。
 *
 * ⚠️ 戻り値の意味が2通りある点に注意（呼び出し側で分岐する）:
 * - カーソルが対象内 → 「現在位置」の index（+dir して移動する）
 * - カーソルが対象外 → 「着地位置」の index（そのまま使う）
 * これを区別するため、`exact` が見つかったかを第2戻り値で返す。
 */
function resolveIndex(
  ids: number[],
  cursorId: number,
  dir: KbdDir,
  allIds?: number[],
): { index: number; exact: boolean } {
  const exact = ids.indexOf(cursorId);
  if (exact >= 0) return { index: exact, exact: true };

  // カーソルが対象リストに無い。全カード列（DOM順）上でのカーソル位置を基準に、
  // 対象リストの各要素が「カーソルより前か後ろか」を判定して最近傍を選ぶ。
  const order = allIds && allIds.length > 0 ? allIds : ids;
  const cursorPos = order.indexOf(cursorId);
  if (cursorPos < 0) {
    // カーソルが DOM 上にも見つからない（フィード再読込で消えた等）→ 端へ。
    return { index: dir === 1 ? 0 : ids.length - 1, exact: false };
  }

  if (dir === 1) {
    // 次へ: カーソルより後ろ（DOM順で後）にある最初の対象。
    let best = -1;
    let bestPos = Number.POSITIVE_INFINITY;
    for (let i = 0; i < ids.length; i++) {
      const p = order.indexOf(ids[i]);
      // p < 0 = 対象が order に無い（ページネーション境界など）→ 判定不能なので除外。
      if (p < 0) continue;
      if (p > cursorPos && p < bestPos) {
        bestPos = p;
        best = i;
      }
    }
    return { index: best >= 0 ? best : ids.length - 1, exact: false };
  }

  // 前へ: カーソルより前（DOM順で前）にある最後の対象。
  let best = -1;
  let bestPos = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < ids.length; i++) {
    const p = order.indexOf(ids[i]);
    // p < 0 = 対象が order に無い → 除外（-1 を「カーソルより前」と誤判定しない）。
    if (p < 0) continue;
    if (p < cursorPos && p > bestPos) {
      bestPos = p;
      best = i;
    }
  }
  // 前に無ければ**先頭**でクランプ（末尾へラップさせない）。カーソルが
  // 最初の対象より上にある＝上端にいるので、上端の対象に留まるのが正しい。
  return { index: best >= 0 ? best : 0, exact: false };
}

/**
 * 現在のカーソル位置から、次の移動先のカードIDを計算する。
 *
 * @param ids   走査対象のカードID配列（DOM順）。J/K は全カード、N/P は親カードのみ。
 * @param cursorId 現在のカーソル位置のカードID。null なら未選択。
 * @param dir   移動方向。1=次へ、-1=前へ。
 * @param allIds メイン列の全カードの DOM 順リスト（位置解決の基準・任意）。
 *               J/K では `ids` 自身と同じなので省略可。N/P では必須
 *               （コメント上のカーソルを親リストへ解決するため）。
 * @returns 次の移動先のカードID。ids が空なら null。
 */
export function computeNextKbdId(
  ids: number[],
  cursorId: number | null,
  dir: KbdDir,
  allIds?: number[],
): number | null {
  if (ids.length === 0) return null;

  // 未選択（カーソルなし）: どちらの方向でも先頭から開始。
  if (cursorId == null) return ids[0];

  const { index, exact } = resolveIndex(ids, cursorId, dir, allIds);

  // カーソルが対象リストに無かった場合、resolveIndex が既に「着地位置」を
  // 返しているので、そこへ直接着地する（+dir しない）。
  if (!exact) return ids[index];

  if (dir === 1) {
    // 次へ。末尾でクランプ（ラップしない）。ページネーションで新しいカードが
    // 末尾に追記されるのを待つため、末尾で止める。
    return index + 1 < ids.length ? ids[index + 1] : ids[index];
  }
  // 前へ。先頭でクランプ（ラップしない）。
  return index - 1 >= 0 ? ids[index - 1] : ids[index];
}
