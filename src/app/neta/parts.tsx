/* 📝 ネタ帳の公開ページの頭と足（サーバで描画）。 */
import Link from "next/link";
import { getNetaViewer } from "@/lib/neta-auth";
import { netaLive, netaWritable } from "@/lib/neta-write";
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

export async function NetaHeader({ writable }: { writable: boolean }) {
  // 切り替えの後、まだログインしていない人に「引っ越したこと」と「参加には無料登録が要ること」を出す（ドリキン 2026-11-15）。
  const loggedIn = netaLive() ? !!(await getNetaViewer().catch(() => null)) : true;
  return (
    <>
      <header className={s.brand}>
        <Link href="/neta">
          <div className={s.brandName}>📝 backspace.fm のネタ帳</div>
          <div className={s.brandSub}>番組で話してほしいネタを、みんなで投稿して投票する場所</div>
        </Link>
        <NetaAccount />
      </header>
      {netaLive() ? null : <p className={s.notice}>
        いまは試験公開中です。ネタの投稿と「聞きたい」は、これまでどおり{" "}
        <a href={NETA_LEGACY_SITE} target="_blank" rel="noopener noreferrer">
          neta.backspace.fm
        </a>{" "}
        でどうぞ。
      </p>}
      {netaLive() && !loggedIn ? (
        <div className={s.notice}>
          <p style={{ margin: 0, fontWeight: 700 }}>ネタ帳は neta.backspace.fm からここへ引っ越しました</p>
          <ul style={{ margin: "6px 0 0", paddingLeft: "1.2em" }}>
            <li>これまでの週のネタと「聞きたい」の数は、そのまま引き継いでいます。</li>
            <li>読むのは、だれでもログインなしでできます。</li>
            <li>
              「聞きたい」・投稿・コメントには、<b>backspace.fm の無料登録</b>が要ります。メールアドレスだけで、お金はかかりません。右上の「ログイン / 無料登録」からどうぞ。
            </li>
            <li>すでに backspace.fm に登録している方（BSM の会員の方も）は、同じメールアドレスでログインしてください。</li>
          </ul>
        </div>
      ) : null}
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
