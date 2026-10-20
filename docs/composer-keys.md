# 入力欄の Enter と改行（全プラットフォーム共通のルール）

決定: ドリキン 2026-10-19。チャット・スレッドの返信・新規投稿・編集の、すべての入力欄で同じ。
変える前に必ずこの表を直し、最後の確認リストを全部やること（どこかを触ると別の所が壊れてきたため）。

## ルール

| キーボード | Enter | ⇧Enter | ⌘/Ctrl+Enter | 日本語変換を確定する Enter | @候補が出ているときの Enter |
|---|---|---|---|---|---|
| 物理キーボード（Mac、Web のパソコン、iPad・iPhone・Android の外付け） | 送信 | 改行 | 送信 | 確定だけ（送らない） | 候補を補完 |
| 画面キーボード（iPhone・iPad・Android、Web のスマホ） | 改行 | ― | ― | 確定だけ | 改行（候補はタップで選ぶ） |

- 送信ボタンは、どの場合でも使える（画面キーボードでは唯一の送信手段）。
- 編集中の Enter は「保存」、Esc は中止（物理キーボード）。
- 「（Enter 送信・⇧Enter 改行）」のヒントは、Enter で送信になるときだけ出す。
- Web の「うなる」は ⇧Enter ではなく、送信の隣のボタン。

## 物理か画面かの見分け方（推測ではなく、キーの届き方で決める）

- **iOS / iPadOS**: 物理キーボードの Return は `UIKeyCommand`（`pressesBegan`）で届き、画面キーボードの return は
  `insertText("\n")` で届く。前者だけを送信にする。変換中（`markedTextRange != nil`）は何もしない。
- **Android**: `KeyEvent.device?.isVirtual == false`（または `KeyEvent.deviceId` が仮想キーボードでない）の Enter だけ送信。
  画面キーボード（IME）は改行を文字として入れる。変換中（`composition != null`）は何もしない。
- **macOS**: 物理キーボードだけ。変換中（`hasMarkedText`）は IME に任せる。
- **Web**: `(hover: none) and (pointer: coarse)` の端末は画面キーボードとみなし、Enter は改行。
  変換中は `e.isComposing || e.keyCode === 229` で何もしない（Safari は確定の Enter を isComposing=false で出すことがある）。

## 実装の置き場所（各プラットフォーム 1 か所）

- macOS: `native/shared/Platform.swift` の `returnSends`（すべての入力欄が使う）
- iOS: `native/ios/Sources/ComposerTextView.swift`（すべての入力欄が使う）
- Android: `Modifier.composerKeys(...)`（チャット・返信・新規投稿・編集が使う）
- Web: `useComposerKeys(...)`（`MentionTextarea` と、すべての textarea が使う）

## 変更したら必ず確かめること

1. Enter → 送信
2. ⇧Enter → カーソルの位置で改行
3. 日本語変換中の Enter → 確定だけ、送らない
4. 確定のあともう一度 Enter → 送信
5. 画面キーボードの return → 改行（iPhone、iPad のフローティングキーボード、Android の Gboard、スマホの Safari）
6. `@名前` の候補が出ているときの Enter → 補完だけ
7. 編集中の Enter → 保存、Esc → 中止
8. ⌘Enter → 送信
9. 音声入力の途中で送信 → 残りの文字が後から出てこない
10. チャット・スレッドの返信・新規投稿の 3 か所で同じ動きになる
11. ヒントの表示が実際の動きと合っている
