"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import s from "../neta.module.css";

/** 戻り先は /neta の中だけ（サーバの netaNext と同じ決まり）。 */
function safeNext(raw: string | null): string {
  return raw && /^\/neta(?:[/?#][^\s\\]*)?$/.test(raw) && !raw.startsWith("//") ? raw : "/neta";
}

export default function NetaLinkLogin() {
  const [msg, setMsg] = useState("ログインしています…");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.slice(1));
    const token = h.get("t");
    const next = safeNext(h.get("n"));
    // トークンを履歴やアドレス欄に残さない。
    history.replaceState(null, "", "/neta/login");
    if (!token) {
      setFailed(true);
      setMsg("リンクが読めませんでした。もう一度ログインメールを送ってください");
      return;
    }
    (async () => {
      try {
        const r = await fetch("/api/neta/auth/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          setFailed(true);
          setMsg(typeof d.error === "string" ? d.error : "ログインできませんでした");
          return;
        }
        window.location.replace(next);
      } catch {
        setFailed(true);
        setMsg("通信できませんでした。もう一度お試しください");
      }
    })();
  }, []);
  return (
    <div className={s.loginPage}>
      <p>{msg}</p>
      {failed && <Link href="/neta">ネタ帳へ戻る</Link>}
    </div>
  );
}
