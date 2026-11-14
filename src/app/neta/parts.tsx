/* 📝 ネタ帳の公開ページの頭と足（サーバで描画）。 */
import Link from "next/link";
import s from "./neta.module.css";

/** 第 1 段階は読むだけ。投稿と「聞きたい」は neta.backspace.fm のまま（切り替えの日にこの案内を外す）。 */
export const NETA_LEGACY_SITE = "https://neta.backspace.fm";

export function NetaHeader() {
  return (
    <>
      <header className={s.brand}>
        <Link href="/neta">
          <div className={s.brandName}>📝 backspace.fm のネタ帳</div>
          <div className={s.brandSub}>番組で話してほしいネタを、みんなで投稿して投票する場所</div>
        </Link>
      </header>
      <p className={s.notice}>
        いまは試験公開中です。ネタの投稿と「聞きたい」は、これまでどおり{" "}
        <a href={NETA_LEGACY_SITE} target="_blank" rel="noopener noreferrer">
          neta.backspace.fm
        </a>{" "}
        でどうぞ。
      </p>
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
