/* 📝 切り替えの後、まだログインしていない人に出す案内（ドリキン 2026-11-15/16）。
 * /neta の頭（parts.tsx）と、neta.backspace.fm から転送されてくる B-guru のトップ（GuestShell）で同じものを出す。 */
import s from "./neta.module.css";

export function NetaMovedNotice() {
  return (
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
  );
}
