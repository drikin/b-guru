/**
 * Mac アプリの中で開いた Web 版タイムライン（試験的、ドリキン 2026-10-31）。
 * アプリの WebView は UA の末尾に `BguruMacApp/<版>` を付ける。チャットはアプリのものを使うので、
 * この中では上部の「チャット」を出さず、チャットを開く操作はアプリに頼む（bguruMac のメッセージ）。
 */
export const MAC_APP_UA = /\bBguruMacApp\/\d/;

export function inMacApp(ua: string | undefined = typeof navigator === "undefined" ? undefined : navigator.userAgent): boolean {
  return !!ua && MAC_APP_UA.test(ua);
}

/** mention: 入力欄に入れる @ 名前、shogiGameId: 開く対局。 */
type MacAppMessage = { type: "openChat"; mention?: string; shogiGameId?: number };

/** アプリに頼む。アプリの中でなければ何もしない（false）。 */
export function askMacApp(msg: MacAppMessage): boolean {
  if (typeof window === "undefined") return false;
  const h = (window as unknown as { webkit?: { messageHandlers?: { bguruMac?: { postMessage(m: unknown): void } } } })
    .webkit?.messageHandlers?.bguruMac;
  if (!h) return false;
  h.postMessage(msg);
  return true;
}
