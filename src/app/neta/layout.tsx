/* 📝 ネタ帳（/neta 以下）。ログインなしで誰でも読める公開ページ（docs/neta-integration-plan.md）。 */
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: { default: "backspace.fm のネタ帳", template: "%s | backspace.fm のネタ帳" },
  description: "ポッドキャスト backspace.fm で話してほしいネタを、みんなで投稿して「聞きたい」で投票するランキング",
  // 第 1 段階（試験公開）の間は検索に載せない（neta.backspace.fm と同じ中身が二重になるため）。
  // 切り替えの日（neta.backspace.fm をここへ転送する日）に外す。
  robots: { index: false, follow: false },
  openGraph: { siteName: "backspace.fm のネタ帳", type: "website", locale: "ja_JP" },
};

export default function NetaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
