import type React from "react";
import { describe, expect, it, vi } from "vitest";
import { decideComposerKey, handleComposerKeyDown, type ComposerKeyInput } from "@/lib/composer-keys";

// docs/composer-keys.md の表をそのままテストにしたもの。
const key = (over: Partial<ComposerKeyInput>): ComposerKeyInput => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  coarse: false,
  mentionOpen: false,
  editing: false,
  ...over,
});

describe("decideComposerKey — 物理キーボード", () => {
  it("Enter → 送信", () => expect(decideComposerKey(key({}))).toBe("send"));
  it("⇧Enter → 改行（ブラウザに任せる）", () => expect(decideComposerKey(key({ shiftKey: true }))).toBe("none"));
  it("⌥Enter → 改行", () => expect(decideComposerKey(key({ altKey: true }))).toBe("none"));
  it("⌘Enter → 送信", () => expect(decideComposerKey(key({ metaKey: true }))).toBe("send"));
  it("Ctrl+Enter → 送信", () => expect(decideComposerKey(key({ ctrlKey: true }))).toBe("send"));
  it("ほかのキーは何もしない", () => expect(decideComposerKey(key({ key: "a", keyCode: 65 }))).toBe("none"));
  it("@候補が出ているときの Enter → 補完", () =>
    expect(decideComposerKey(key({ mentionOpen: true }))).toBe("pick"));
  it("@候補が出ていても ⇧Enter は改行", () =>
    expect(decideComposerKey(key({ mentionOpen: true, shiftKey: true }))).toBe("none"));
  it("@候補が出ていても ⌘Enter は送信", () =>
    expect(decideComposerKey(key({ mentionOpen: true, metaKey: true }))).toBe("send"));
  it("@候補が出ているときの Esc → 候補を閉じる（編集中でも）", () =>
    expect(decideComposerKey(key({ key: "Escape", keyCode: 27, mentionOpen: true, editing: true }))).toBe("closeMention"));
});

describe("decideComposerKey — 日本語変換中", () => {
  it("isComposing の Enter → 何もしない", () => expect(decideComposerKey(key({ isComposing: true }))).toBe("none"));
  it("keyCode 229（Safari の確定 Enter）→ 何もしない", () =>
    expect(decideComposerKey(key({ keyCode: 229 }))).toBe("none"));
  it("変換中は ⌘Enter も送らない", () =>
    expect(decideComposerKey(key({ isComposing: true, metaKey: true }))).toBe("none"));
  it("変換中は @候補の補完もしない", () =>
    expect(decideComposerKey(key({ isComposing: true, mentionOpen: true }))).toBe("none"));
  it("変換中の Esc は編集を中止しない", () =>
    expect(decideComposerKey(key({ key: "Escape", isComposing: true, editing: true }))).toBe("none"));
});

describe("decideComposerKey — 画面キーボード（coarse）", () => {
  it("Enter → 改行", () => expect(decideComposerKey(key({ coarse: true }))).toBe("none"));
  it("@候補が出ていても Enter は改行（候補はタップで選ぶ）", () =>
    expect(decideComposerKey(key({ coarse: true, mentionOpen: true }))).toBe("none"));
  it("編集中でも Enter は改行", () =>
    expect(decideComposerKey(key({ coarse: true, editing: true }))).toBe("none"));
  it("⌘Enter（外付けキーボードからだけ来る）→ 送信", () =>
    expect(decideComposerKey(key({ coarse: true, metaKey: true }))).toBe("send"));
});

describe("decideComposerKey — 編集中", () => {
  it("Enter → 保存（send）", () => expect(decideComposerKey(key({ editing: true }))).toBe("send"));
  it("⇧Enter → 改行", () => expect(decideComposerKey(key({ editing: true, shiftKey: true }))).toBe("none"));
  it("Esc → 中止", () => expect(decideComposerKey(key({ key: "Escape", keyCode: 27, editing: true }))).toBe("cancel"));
  it("編集中でなければ Esc は何もしない", () =>
    expect(decideComposerKey(key({ key: "Escape", keyCode: 27 }))).toBe("none"));
});

describe("handleComposerKeyDown", () => {
  const ev = (over: Partial<{ key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; keyCode: number; isComposing: boolean }> = {}) => {
    const preventDefault = vi.fn();
    return {
      e: {
        key: over.key ?? "Enter",
        shiftKey: !!over.shiftKey,
        metaKey: !!over.metaKey,
        ctrlKey: !!over.ctrlKey,
        altKey: false,
        keyCode: over.keyCode ?? 13,
        nativeEvent: { isComposing: !!over.isComposing },
        preventDefault,
      } as unknown as React.KeyboardEvent<HTMLElement>,
      preventDefault,
    };
  };

  it("Enter で onSend を呼び、改行を止める（window なし＝物理キーボード扱い）", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = ev();
    expect(handleComposerKeyDown(e, { onSend })).toBe("send");
    expect(onSend).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalled();
  });

  it("⇧Enter は何も呼ばず、改行を止めない", () => {
    const onSend = vi.fn();
    const { e, preventDefault } = ev({ shiftKey: true });
    expect(handleComposerKeyDown(e, { onSend })).toBe("none");
    expect(onSend).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("変換中の Enter は送らない", () => {
    const onSend = vi.fn();
    const { e } = ev({ isComposing: true });
    expect(handleComposerKeyDown(e, { onSend })).toBe("none");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("@候補が出ているときは onPickMention を呼び、送らない", () => {
    const onSend = vi.fn();
    const onPickMention = vi.fn();
    const { e } = ev();
    expect(handleComposerKeyDown(e, { onSend, mentionOpen: true, onPickMention })).toBe("pick");
    expect(onPickMention).toHaveBeenCalledOnce();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("onCancel を渡したときだけ Esc で中止", () => {
    const onSend = vi.fn();
    const onCancel = vi.fn();
    expect(handleComposerKeyDown(ev({ key: "Escape", keyCode: 27 }).e, { onSend })).toBe("none");
    expect(handleComposerKeyDown(ev({ key: "Escape", keyCode: 27 }).e, { onSend, onCancel })).toBe("cancel");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("画面キーボードの端末では Enter で送らない", () => {
    const g = globalThis as unknown as { window?: unknown };
    const prev = g.window;
    g.window = { matchMedia: (q: string) => ({ matches: q === "(hover: none) and (pointer: coarse)" }) };
    try {
      const onSend = vi.fn();
      const { e, preventDefault } = ev();
      expect(handleComposerKeyDown(e, { onSend })).toBe("none");
      expect(onSend).not.toHaveBeenCalled();
      expect(preventDefault).not.toHaveBeenCalled();
    } finally {
      g.window = prev;
    }
  });
});
