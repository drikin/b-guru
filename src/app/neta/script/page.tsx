/* 📜 /neta/script — 台本（有料会員だけ読める・管理者が直す）。B-guru の中ではサイドバーの 📜 台本（メインの列）。 */
import type { Metadata } from "next";
import ScriptBoard from "../ScriptBoard";
import s from "../neta.module.css";

export const metadata: Metadata = { title: { absolute: "台本" }, robots: { index: false, follow: false } };

export default function ScriptPage() {
  return (
    <main className={s.page}>
      <ScriptBoard />
    </main>
  );
}
