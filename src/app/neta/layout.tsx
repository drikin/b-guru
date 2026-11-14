/* 📝 ネタ帳（/neta 以下）。ログインなしで誰でも読める公開ページ（docs/neta-integration-plan.md）。 */
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: { default: "backspace.fm のネタ帳", template: "%s | backspace.fm のネタ帳" },
    description: "ポッドキャスト backspace.fm で話してほしいネタを、みんなで投稿して「聞きたい」で投票するランキング",
    // 試験公開の間は検索に載せない（neta.backspace.fm と同じ中身が二重になるため）。
    // 切り替え（NETA_WRITE_ENABLED=1、neta.backspace.fm をここへ転送する）で載せる。
    robots: process.env.NETA_WRITE_ENABLED === "1" ? { index: true, follow: true } : { index: false, follow: false },
    openGraph: { siteName: "backspace.fm のネタ帳", type: "website", locale: "ja_JP" },
  };
}

export default function NetaLayout({ children }: { children: React.ReactNode }) {
  return children;
}
