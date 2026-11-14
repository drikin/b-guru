/* 📝 /neta/app — アプリの 📝 タブ（WebView）に出すネタ帳。中身は B-guru の中のネタ帳（NetaBoard）と同じで、
 * ページを移らずに切り替える。ログインは /neta/app/enter（アプリの鍵）で置いたネタ帳のログイン。 */
import type { Metadata } from "next";
import NetaBoard from "../NetaBoard";
import s from "../neta.module.css";

export const metadata: Metadata = { title: { absolute: "ネタ帳" }, robots: { index: false, follow: false } };

export default function NetaAppPage() {
  return (
    <main className={s.page}>
      <NetaBoard app />
    </main>
  );
}
