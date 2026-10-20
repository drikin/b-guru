// 入力欄の Enter と改行（Web）。ルールの正本は docs/composer-keys.md（ドリキン 2026-10-19）。
//
// - 物理キーボード: Enter 送信・⇧Enter 改行・⌘/Ctrl+Enter 送信・@候補が出ていれば Enter で補完
// - 画面キーボード（`(hover: none) and (pointer: coarse)` の端末）: Enter は改行。送信はボタンだけ
// - 日本語変換中（isComposing / keyCode 229）は何もしない
// - 編集中は Enter 保存・Esc 中止
//
// チャット・チャットの編集・返信・コメント・新規投稿・投稿の編集のすべての入力欄が
// ここを通る。どこか 1 か所だけ別の動きにしないこと。

import { useCallback, useSyncExternalStore } from "react";
import type React from "react";

/** 画面キーボードの端末とみなす条件（docs/composer-keys.md）。 */
export const COARSE_POINTER_QUERY = "(hover: none) and (pointer: coarse)";

/** 「Enter で送信」になるときだけ出すヒント。 */
export const SEND_HINT = "Enter 送信・⇧Enter 改行";
export const EDIT_HINT = "Enter 保存・⇧Enter 改行・Esc キャンセル";
/** Esc はモーダル側が閉じる編集欄用。 */
export const SAVE_HINT = "Enter 保存・⇧Enter 改行";

export type ComposerKeyAction =
  | "none" // ブラウザに任せる（Enter なら改行）
  | "send" // 送信（編集中なら保存）
  | "pick" // @候補を補完
  | "cancel" // 編集を中止
  | "closeMention"; // @候補を閉じる

export interface ComposerKeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey?: boolean;
  /** KeyboardEvent.isComposing */
  isComposing: boolean;
  /** KeyboardEvent.keyCode（Safari は確定の Enter を isComposing=false・keyCode 229 で出すことがある） */
  keyCode?: number;
  /** 画面キーボードの端末か */
  coarse: boolean;
  /** @候補の一覧が出ているか */
  mentionOpen?: boolean;
  /** 編集中か（Esc で中止できるか） */
  editing?: boolean;
}

/** キー 1 つに対して何をするかを決める（副作用なし・テスト用に分けてある）。 */
export function decideComposerKey(i: ComposerKeyInput): ComposerKeyAction {
  // 変換中の Enter / Esc は IME のもの。
  if (i.isComposing || i.keyCode === 229) return "none";

  if (i.key === "Escape") {
    if (i.mentionOpen) return "closeMention";
    if (i.editing) return "cancel";
    return "none";
  }

  if (i.key !== "Enter") return "none";

  // ⌘/Ctrl+Enter は物理キーボードからしか来ないので、どの端末でも送信。
  if (i.metaKey || i.ctrlKey) return "send";
  // ⇧Enter（と ⌥Enter）は改行。
  if (i.shiftKey || i.altKey) return "none";
  // 画面キーボードの Enter は改行（@候補もタップで選ぶ）。
  if (i.coarse) return "none";
  if (i.mentionOpen) return "pick";
  return "send";
}

/** 今の端末が画面キーボードの端末か（イベントのたびに読む）。 */
export function isCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(COARSE_POINTER_QUERY).matches;
  } catch {
    return false;
  }
}

export interface ComposerKeyOptions {
  /** 送信（編集中なら保存） */
  onSend: () => void;
  /** 編集の中止。渡すと Esc で呼ぶ（編集中の入力欄だけ渡す） */
  onCancel?: () => void;
  /** @候補が出ているか */
  mentionOpen?: boolean;
  /** @候補を補完する */
  onPickMention?: () => void;
  /** @候補を閉じる */
  onCloseMention?: () => void;
}

/** textarea の onKeyDown で呼ぶ。実際に行った動作を返す（"none" ならブラウザに任せた）。 */
export function handleComposerKeyDown(
  e: React.KeyboardEvent<HTMLElement>,
  opts: ComposerKeyOptions,
): ComposerKeyAction {
  const native = e.nativeEvent as KeyboardEvent;
  const action = decideComposerKey({
    key: e.key,
    shiftKey: e.shiftKey,
    metaKey: e.metaKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
    isComposing: !!native?.isComposing,
    keyCode: e.keyCode,
    coarse: isCoarsePointer(),
    mentionOpen: !!opts.mentionOpen,
    editing: !!opts.onCancel,
  });
  switch (action) {
    case "send":
      e.preventDefault();
      opts.onSend();
      return action;
    case "pick":
      if (!opts.onPickMention) return "none";
      e.preventDefault();
      opts.onPickMention();
      return action;
    case "cancel":
      e.preventDefault();
      opts.onCancel?.();
      return action;
    case "closeMention":
      if (!opts.onCloseMention) return "none";
      opts.onCloseMention();
      return action;
    default:
      return "none";
  }
}

/** onKeyDown に渡す関数を返す。 */
export function useComposerKeys(opts: ComposerKeyOptions) {
  const { onSend, onCancel, mentionOpen, onPickMention, onCloseMention } = opts;
  return useCallback(
    (e: React.KeyboardEvent<HTMLElement>) =>
      handleComposerKeyDown(e, { onSend, onCancel, mentionOpen, onPickMention, onCloseMention }),
    [onSend, onCancel, mentionOpen, onPickMention, onCloseMention],
  );
}

function subscribeCoarse(cb: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mq = window.matchMedia(COARSE_POINTER_QUERY);
  mq.addEventListener?.("change", cb);
  return () => mq.removeEventListener?.("change", cb);
}

/** Enter で送信になる端末（物理キーボード）なら true。ヒントの出し分けに使う。
 *  サーバーでは false（ヒントなし）にして、表示後に端末に合わせる。 */
export function useEnterSends(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () => !isCoarsePointer(),
    () => false,
  );
}
