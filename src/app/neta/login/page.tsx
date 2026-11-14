/* 📝 /neta/login — メールの「ログインする」ボタンの行き先。トークンは # の後ろにあり、ここで読んで送る。 */
import type { Metadata } from "next";
import NetaLinkLogin from "./NetaLinkLogin";
import s from "../neta.module.css";

export const metadata: Metadata = { title: "ログイン", robots: { index: false, follow: false } };

export default function NetaLoginPage() {
  return (
    <main className={s.page}>
      <NetaLinkLogin />
    </main>
  );
}
