/* 📝 /neta/submit?url=&title=&description= — ブックマークレットと neta.backspace.fm/submit の転送先。投稿欄を開いた状態で出す。 */
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { NetaProvider, NetaSubmit } from "../NetaClient";
import { loadNetaViewer, NetaFooter, NetaHeader } from "../parts";
import s from "../neta.module.css";

export const metadata: Metadata = { title: "ネタを投稿", robots: { index: false, follow: false } };

function one(v: string | string[] | undefined, max: number): string {
  const x = Array.isArray(v) ? v[0] : v;
  return typeof x === "string" ? x.slice(0, max) : "";
}

export default async function NetaSubmitPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const { viewer, writable, admin } = await loadNetaViewer();
  const initial = { url: one(sp.url, 2000), title: one(sp.title, 200), description: one(sp.description, 1000) };
  return (
    <NetaProvider viewer={viewer} writable={writable} admin={admin}>
      <main className={s.page}>
        <NetaHeader writable={writable} />
        <div className={s.back}>
          <Link href="/neta">← 今週のランキング</Link>
        </div>
        <h1 className={s.topicTitle}>今週のネタに投稿</h1>
        {writable ? <NetaSubmit initial={initial} startOpen /> : <p className={s.count}>いまは投稿を受け付けていません。</p>}
        <NetaFooter />
      </main>
    </NetaProvider>
  );
}
