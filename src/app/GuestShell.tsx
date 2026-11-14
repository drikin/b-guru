"use client";
/* B-guru のトップを、ログインしていない人・無料会員に出す形（2026-11-14 オーナー）。
 * 📝 ネタ帳がメインの列に出て、BSM（有料会員）限定の機能は左のメニューにグレーで並ぶだけ（押すと案内）。
 * 会員のデータは何も読まない（ネタ帳の公開 API だけ）。ログインは 1 つ: 有料会員なら B-guru の本体に入る。 */
import { useState } from "react";
import NetaBoard from "./neta/NetaBoard";
import g from "./guest.module.css";

const LOCKED: { key: string; icon: string; label: string; about: string }[] = [
  { key: "feed", icon: "🏠", label: "タイムライン", about: "番組の感想や気になったことを投稿して、みんなと話せます。" },
  { key: "favorites", icon: "☆", label: "お気に入り", about: "気に入った投稿をあとで見返せます。" },
  { key: "bookmarks", icon: "🔖", label: "ブックマーク", about: "投稿を自分用にとっておけます。" },
  { key: "chat", icon: "💬", label: "チャット", about: "番組を聞きながら、リアルタイムにおしゃべりできます。" },
  { key: "dm", icon: "✉️", label: "DM", about: "会員どうしで 1 対 1 やグループで話せます。" },
  { key: "drinews", icon: "📮", label: "ドリニュース", about: "ドリキンのニュースレターを読めます。" },
  { key: "clubs", icon: "🏷", label: "部活", about: "好きな話題ごとの部活で集まれます。" },
];

function openLogin() {
  window.dispatchEvent(new Event("neta:login"));
}

export default function GuestShell() {
  const [locked, setLocked] = useState<(typeof LOCKED)[number] | null>(null);
  const [menu, setMenu] = useState(false);

  const lockedItem = (it: (typeof LOCKED)[number]) => (
    <button
      key={it.key}
      type="button"
      className={`${g.item} ${g.locked} ${locked?.key === it.key ? g.lockedOn : ""}`}
      aria-disabled="true"
      title="BSM（backspace.fm の有料会員）限定"
      onClick={() => {
        setLocked(it);
        setMenu(false);
        window.scrollTo({ top: 0 });
      }}
    >
      <span className={g.icon}>{it.icon}</span>
      <span className={g.label}>{it.label}</span>
      <span className={g.lock} aria-hidden>
        🔒
      </span>
    </button>
  );

  // 並びは B-guru の本体と同じ: タイムライン → 📝 ネタ帳（上から 2 番目）→ ほか（2026-11-14 オーナー）。
  const nav = (
    <nav className={g.nav} aria-label="メニュー">
      {lockedItem(LOCKED[0])}
      <button
        type="button"
        className={`${g.item} ${!locked ? g.on : ""}`}
        onClick={() => {
          setLocked(null);
          setMenu(false);
        }}
      >
        <span className={g.icon}>📝</span>
        <span className={g.label}>ネタ帳</span>
      </button>
      {LOCKED.slice(1).map(lockedItem)}
      <p className={g.sep}>🔒 は BSM（有料会員）限定</p>
    </nav>
  );

  return (
    <div className={g.shell}>
      <header className={g.top}>
        <button type="button" className={g.menuBtn} aria-label="メニュー" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
          ☰
        </button>
        <div className={g.logo}>
          <span className={g.logoMark}>B</span>
          <span className={g.logoText}>B-guru</span>
        </div>
        <button type="button" className={g.loginBtn} onClick={openLogin}>
          ログイン / 無料登録
        </button>
      </header>
      <div className={g.body}>
        <aside className={`${g.side} ${menu ? g.sideOpen : ""}`}>{nav}</aside>
        {menu && <div className={g.scrim} onClick={() => setMenu(false)} />}
        <main className={g.main}>
          {locked && (
            <section className={g.lockedPanel} aria-live="polite">
              <div className={g.lockedTitle}>
                {locked.icon} {locked.label} は BSM 会員限定です 🔒
              </div>
              <p className={g.lockedText}>
                {locked.about}
                B-guru は、ポッドキャスト backspace.fm の有料会員（BSM）のためのコミュニティです。番組を聞きながら、みんなで話せます。
              </p>
              <div className={g.lockedActions}>
                <a className={g.primary} href="https://backspace.fm/" target="_blank" rel="noopener noreferrer">
                  BSM について
                </a>
                <button type="button" className={g.secondary} onClick={openLogin}>
                  会員の方はログイン
                </button>
                <button type="button" className={g.link} onClick={() => setLocked(null)}>
                  ネタ帳に戻る
                </button>
              </div>
            </section>
          )}
          <NetaBoard />
        </main>
      </div>
    </div>
  );
}
