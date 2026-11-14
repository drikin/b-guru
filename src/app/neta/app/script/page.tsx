/* 📜 /neta/app/script — アプリの 📜 タブ（WebView）に出す台本。ログインは /neta/app/enter?to=script（アプリの鍵）で置いたもの。 */
import type { Metadata } from "next";
import ScriptBoard from "../../ScriptBoard";
import s from "../../neta.module.css";

export const metadata: Metadata = { title: { absolute: "台本" }, robots: { index: false, follow: false } };

export default function ScriptAppPage() {
  return (
    <main className={s.page}>
      <ScriptBoard app />
    </main>
  );
}
