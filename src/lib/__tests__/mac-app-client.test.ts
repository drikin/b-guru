import { describe, it, expect } from "vitest";
import { askMacApp, inMacApp } from "../mac-app-client";

describe("Mac アプリの中の Web 版タイムライン", () => {
  it("アプリの WebView の UA だけを見分ける", () => {
    const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
    expect(inMacApp(safari)).toBe(false);
    expect(inMacApp("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) BguruMacApp/0.3.101")).toBe(true);
    expect(inMacApp("NotBguruMacApp/1")).toBe(false);
    expect(inMacApp(undefined)).toBe(false);
  });

  it("アプリに頼む: 受け口があれば渡して true、なければ何もせず false", () => {
    const g = globalThis as unknown as { window?: unknown };
    const sent: unknown[] = [];
    g.window = { webkit: { messageHandlers: { bguruMac: { postMessage: (m: unknown) => sent.push(m) } } } };
    expect(askMacApp({ type: "openChat", mention: "@テスト " })).toBe(true);
    expect(sent).toEqual([{ type: "openChat", mention: "@テスト " }]);
    g.window = {};
    expect(askMacApp({ type: "openChat" })).toBe(false);
    delete g.window;
    expect(askMacApp({ type: "openChat" })).toBe(false);
  });
});
