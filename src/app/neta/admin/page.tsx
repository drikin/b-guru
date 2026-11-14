/* 📝 /neta/admin — ネタ帳の管理（週・台本・タイトル案・書き出し）。B-guru の管理者だけ。 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { adminWeeks, netaAdminEmail } from "@/lib/neta-admin";
import NetaAdmin from "./NetaAdmin";
import s from "../neta.module.css";

export const metadata: Metadata = { title: "管理" };

export default async function NetaAdminPage() {
  await connection();
  if (!(await netaAdminEmail())) notFound();
  const weeks = await adminWeeks();
  return (
    <main className={s.page}>
      <div className={s.back}>
        <Link href="/neta">← ネタ帳へ</Link>
      </div>
      <h1 className={s.weekTitle}>📝 ネタ帳の管理</h1>
      <p className={s.notice}>
        neta.backspace.fm と並べて動かしている間は、ここでの変更は移行のやり直しで上書きされることがあります。切り替えの日から、ここが本番の作業場所になります。
      </p>
      <NetaAdmin weeks={weeks} />
    </main>
  );
}
