/* 📝 ネタ帳の公開ページの頭と足（サーバで描画）。 */
import Link from "next/link";
import { getNetaViewer } from "@/lib/neta-auth";
import { netaWritable } from "@/lib/neta-write";
import { isAdmin } from "@/lib/admin";
import { NetaAccount, type ClientViewer } from "./NetaClient";
import s from "./neta.module.css";

/** 書き込みを開けるまで（NETA_WRITE_ENABLED）、投稿と「聞きたい」は neta.backspace.fm のまま（切り替えの日にこの案内を外す）。 */
export const NETA_LEGACY_SITE = "https://neta.backspace.fm";

/** 見ている人（押せる所に渡す形。メールアドレスは渡さない）と、書き込めるか・聞きたいの印に使う id。 */
export async function loadNetaViewer(): Promise<{ viewer: ClientViewer; writable: boolean; memberId: number | null; admin: boolean }> {
  const v = await getNetaViewer().catch(() => null);
  return {
    viewer: v ? { displayName: v.member?.displayName ?? null, tier: v.tier } : null,
    writable: netaWritable(v),
    memberId: v?.member?.id ?? null,
    // 管理（採用・削除・週・台本）は B-guru の有料会員としてログインしている管理者だけ。
    admin: !!v && v.tier === "paid" && isAdmin(v.email),
  };
}

export function NetaHeader({ writable }: { writable: boolean }) {
  return (
    <>
      <header className={s.brand}>
        <Link href="/neta">
          <div className={s.brandName}>📝 backspace.fm のネタ帳</div>
          <div className={s.brandSub}>番組で話してほしいネタを、みんなで投稿して投票する場所</div>
        </Link>
        <NetaAccount />
      </header>
      {writable ? null : <p className={s.notice}>
        いまは試験公開中です。ネタの投稿と「聞きたい」は、これまでどおり{" "}
        <a href={NETA_LEGACY_SITE} target="_blank" rel="noopener noreferrer">
          neta.backspace.fm
        </a>{" "}
        でどうぞ。
      </p>}
    </>
  );
}

export function NetaFooter() {
  return (
    <footer className={s.footer}>
      <div>
        ポッドキャスト{" "}
        <a href="https://backspace.fm/" target="_blank" rel="noopener noreferrer">
          backspace.fm
        </a>{" "}
        のネタ帳です。リンク先の記事の内容は、それぞれのサイトのものです。
      </div>
    </footer>
  );
}
