import { describe, it, expect } from "vitest";
import { computeNextKbdId } from "../kbd-nav";

/**
 * JK/NP キーボードナビゲーションの移動ロジックの回帰テスト。
 *
 * 背景1: kai3desu から「JKとNPの挙動が別になってて、JKで読んでるときにNP押すと
 * 戻っちゃう」というデグレ報告（posts id=3468）が来た。JK（全カード）とNP（親カード
 * のみ）は走査対象が違うだけで、移動ロジック自体は同一のはず。このテストで
 * 移動ロジックの回帰を防ぐ。
 *
 * 背景2（2026-09-15・kai3desu フィードバック）: 「NでここはJで読もうかなと思うと
 * TOPもどっちゃうので（その逆も）、NもJも場所覚えてくれると嬉しい」。
 * → J/K と N/P は**同じカーソルを共有**し、モードを跨いでも位置が繋がるように
 *    した（TOP に戻らない）。この挙動をテストで固定する。
 */

describe("computeNextKbdId", () => {
  // 全カード（J/K用）: コメント含む
  const allCards = [10, 20, 30, 40, 50];
  // 親カードのみ（N/P用）: ルート投稿だけ
  const parents = [10, 30, 50];

  describe("未選択（cursorId=null）", () => {
    it("どちらの方向でも先頭から開始する", () => {
      expect(computeNextKbdId(allCards, null, 1)).toBe(10);
      expect(computeNextKbdId(allCards, null, -1)).toBe(10);
      expect(computeNextKbdId(parents, null, 1)).toBe(10);
      expect(computeNextKbdId(parents, null, -1)).toBe(10);
    });
  });

  describe("次へ（dir=1）", () => {
    it("次のカードに移動する", () => {
      expect(computeNextKbdId(allCards, 10, 1)).toBe(20);
      expect(computeNextKbdId(allCards, 30, 1)).toBe(40);
    });

    it("末尾でクランプする（ラップしない）", () => {
      expect(computeNextKbdId(allCards, 50, 1)).toBe(50);
      expect(computeNextKbdId(parents, 50, 1)).toBe(50);
    });

    it("親カードのみの走査ではコメントをスキップする", () => {
      // カーソルが10（親）のとき、N/Pの次は30（次の親）。20はコメントなので飛ばす。
      expect(computeNextKbdId(parents, 10, 1)).toBe(30);
    });
  });

  describe("前へ（dir=-1）", () => {
    it("前のカードに移動する", () => {
      expect(computeNextKbdId(allCards, 30, -1)).toBe(20);
      expect(computeNextKbdId(allCards, 50, -1)).toBe(40);
    });

    it("先頭でクランプする（ラップしない）", () => {
      expect(computeNextKbdId(allCards, 10, -1)).toBe(10);
      expect(computeNextKbdId(parents, 10, -1)).toBe(10);
    });
  });

  describe("カーソルが走査対象に含まれない場合（allIds 未指定）", () => {
    it("次へなら先頭、前へなら末尾に移動する", () => {
      // フィード再読込などでカーソル位置のカードが消えたケース
      expect(computeNextKbdId(allCards, 999, 1)).toBe(10);
      expect(computeNextKbdId(allCards, 999, -1)).toBe(50);
    });
  });

  describe("空配列", () => {
    it("null を返す", () => {
      expect(computeNextKbdId([], null, 1)).toBeNull();
      expect(computeNextKbdId([], 10, -1)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 位置同期（2026-09-15・kai3desu フィードバック）: J/K と N/P を跨いでも
  // TOP に戻らず、今読んでいる場所から見て次/前の対象へ進む。
  // ---------------------------------------------------------------------------
  describe("位置同期: J/K のコメント位置から N/P へ（TOPに戻らない）", () => {
    // DOM順（last_activity DESC を模した並び。ID順とは一致しない点が重要）:
    //   親100 / コメント101,102 / 親200 / コメント201 / 親300
    const domAll = [100, 101, 102, 200, 201, 300];
    const domParents = [100, 200, 300];

    it("コメント102にいるとき N を押すと、次の親200へ進む（先頭100に戻らない）", () => {
      expect(computeNextKbdId(domParents, 102, 1, domAll)).toBe(200);
    });

    it("コメント201にいるとき N を押すと、次の親300へ進む", () => {
      expect(computeNextKbdId(domParents, 201, 1, domAll)).toBe(300);
    });

    it("コメント102にいるとき P を押すと、前の親100へ戻る", () => {
      expect(computeNextKbdId(domParents, 102, -1, domAll)).toBe(100);
    });

    it("コメント201にいるとき P を押すと、前の親200へ戻る", () => {
      expect(computeNextKbdId(domParents, 201, -1, domAll)).toBe(200);
    });

    it("最後の親の後ろのコメントにいるとき N を押すと、末尾の親でクランプする", () => {
      // 親300 の後ろにコメント301がある想定
      const all = [100, 101, 102, 200, 201, 300, 301];
      expect(computeNextKbdId(domParents, 301, 1, all)).toBe(300);
    });

    it("最初の親より前のコメントにいるとき P を押すと、先頭の親でクランプする", () => {
      const all = [99, 100, 101, 200];
      expect(computeNextKbdId(domParents, 99, -1, all)).toBe(100);
    });
  });

  describe("位置同期: N/P の親位置から J/K へ（その親の直後へ進む）", () => {
    const domAll = [100, 101, 102, 200, 201, 300];

    it("親100にいるとき J を押すと、直後のコメント101へ進む", () => {
      expect(computeNextKbdId(domAll, 100, 1, domAll)).toBe(101);
    });

    it("親200にいるとき J を押すと、直後のコメント201へ進む", () => {
      expect(computeNextKbdId(domAll, 200, 1, domAll)).toBe(201);
    });

    it("親200にいるとき K を押すと、前のコメント102へ戻る", () => {
      expect(computeNextKbdId(domAll, 200, -1, domAll)).toBe(102);
    });
  });

  describe("位置同期: 最端のクランプ（既知の制限・意図的）", () => {
    // 最後の親より後ろのコメントにいるとき、N は末尾の親にクランプする。
    // その後 K で戻ると「その親の前のカード」へ進む（元のコメントには戻らない）。
    // 最端では「次/前の親」が存在しないため、サブ位置を保持する先が無い。
    const domAll = [50, 51, 900, 901];
    const domParents = [50, 900];

    it("最後の親より後ろのコメントで N を押すと末尾の親にクランプする", () => {
      expect(computeNextKbdId(domParents, 901, 1, domAll)).toBe(900);
    });

    it("その親から K を押すと前のカードへ進む（元のコメントには戻らない）", () => {
      expect(computeNextKbdId(domAll, 900, -1, domAll)).toBe(51);
    });

    it("その親から J を押すと直後のコメントへ進む", () => {
      expect(computeNextKbdId(domAll, 900, 1, domAll)).toBe(901);
    });
  });

  describe("位置同期: 親が allIds に存在しない場合（不変条件違反の防御）", () => {
    // 通常 parents は allIds の部分列なのでこの状況は起きないが、将来
    // allIds をフィルタする改修が入ると壊れる。そのとき「黙って到達不能に
    // なる」のではなく、意図した挙動をテストで固定しておく。
    // 仕様: allIds に無い親は位置解決の対象から除外し、端へクランプする。
    it("allIds に無い親はスキップされ、端へクランプする", () => {
      // allIds に 900 が無い → 900 は到達不能。カーソル53の次は無いので末尾(900)へ。
      expect(computeNextKbdId([50, 900], 53, 1, [50, 51, 52, 53])).toBe(900);
    });

    it("allIds に無い親は後方探索でもスキップされる", () => {
      // カーソル53より前で allIds に存在する親は 50 のみ。
      expect(computeNextKbdId([50, 900], 53, -1, [50, 51, 52, 53])).toBe(50);
    });

    it("部分列の不変条件: parents ⊆ allIds なら全親が到達可能", () => {
      const allIds = [50, 51, 52, 900, 901];
      const parents = [50, 900];
      // 50 から N で 900 に到達できる（スキップされない）
      expect(computeNextKbdId(parents, 50, 1, allIds)).toBe(900);
      // 900 から P で 50 に戻れる
      expect(computeNextKbdId(parents, 900, -1, allIds)).toBe(50);
    });
  });

  describe("位置同期: DOM順 ≠ ID順 でも正しく解決する", () => {
    // コメントが付いた古い投稿（ID小）が上に浮上するケース。
    // DOM順: 親50(古いがコメントで浮上) / コメント51 / 親900(新しい) / コメント901
    const domAll = [50, 51, 900, 901];
    const domParents = [50, 900];

    it("IDの大小ではなく DOM 順で次を選ぶ（コメント51 → 親900）", () => {
      // ID だけ見ると 51 < 900 なので「IDが小さい側」を探す実装だと誤動作する。
      expect(computeNextKbdId(domParents, 51, 1, domAll)).toBe(900);
    });

    it("IDの大小ではなく DOM 順で前を選ぶ（コメント901 → 親900）", () => {
      expect(computeNextKbdId(domParents, 901, -1, domAll)).toBe(900);
    });
  });
});
