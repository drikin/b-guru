"use client";
/* 📝 ネタ帳の操作（聞きたい・ログインのシート・投稿・コメント・名前）。ページ本体はサーバで描画し、ここは押せる所だけ。 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import s from "./neta.module.css";

export type ClientViewer = { displayName: string | null; tier: "paid" | "free" } | null;

type Ctx = {
  viewer: ClientViewer;
  writable: boolean;
  /** B-guru の管理者（採用・削除・管理画面）。 */
  admin: boolean;
  /** ログインのシートを開く。ログインできたら after を実行する（押した「聞きたい」を入れる など）。 */
  requireLogin: (after?: () => void | Promise<void>) => void;
  setDisplayName: (name: string) => void;
};

const NetaCtx = createContext<Ctx | null>(null);

function useNeta(): Ctx {
  const c = useContext(NetaCtx);
  if (!c) throw new Error("NetaProvider がありません");
  return c;
}

async function postJson(url: string, body: unknown, method = "POST"): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "通信できませんでした。電波のよい所でもう一度どうぞ" } };
  }
}

function errText(data: Record<string, unknown>, fallback = "うまくいきませんでした"): string {
  return typeof data.error === "string" && data.error ? data.error : fallback;
}

export function NetaProvider({ viewer: initial, writable, admin = false, children }: { viewer: ClientViewer; writable: boolean; admin?: boolean; children: ReactNode }) {
  const [viewer, setViewer] = useState<ClientViewer>(initial);
  const [sheet, setSheet] = useState(false);
  const after = useRef<(() => void | Promise<void>) | null>(null);
  const router = useRouter();
  useEffect(() => setViewer(initial), [initial]);

  const requireLogin = useCallback(
    (fn?: () => void | Promise<void>) => {
      if (viewer) {
        void fn?.();
        return;
      }
      after.current = fn ?? null;
      setSheet(true);
    },
    [viewer]
  );

  const onLoggedIn = useCallback(
    async (displayName: string | null) => {
      setViewer({ displayName, tier: "free" });
      setSheet(false);
      const fn = after.current;
      after.current = null;
      if (fn) await fn();
      router.refresh();
    },
    [router]
  );

  return (
    <NetaCtx.Provider
      value={{ viewer, writable, admin, requireLogin, setDisplayName: (n) => setViewer((v) => (v ? { ...v, displayName: n } : v)) }}
    >
      {children}
      {sheet && <LoginSheet onClose={() => setSheet(false)} onDone={onLoggedIn} />}
    </NetaCtx.Provider>
  );
}

/** ヘッダの右: ログイン・名前・ログアウト。 */
export function NetaAccount() {
  const { viewer, writable, admin, requireLogin } = useNeta();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  if (!writable && !viewer) return null;
  if (!viewer) {
    return (
      <button type="button" className={s.accountBtn} onClick={() => requireLogin()}>
        ログイン / 無料登録
      </button>
    );
  }
  return (
    <div className={s.account}>
      {admin && !editing && (
        <Link href="/neta/admin" className={s.linkBtn}>
          ⚙ 管理
        </Link>
      )}
      {editing ? (
        <NameForm onDone={() => setEditing(false)} />
      ) : (
        <button type="button" className={s.linkBtn} onClick={() => setEditing(true)} title="ネタ帳で表示する名前">
          {viewer.displayName ? `👤 ${viewer.displayName}` : "名前を決める"}
        </button>
      )}
      {viewer.tier === "free" && !editing && (
        <button
          type="button"
          className={s.linkBtn}
          onClick={async () => {
            await postJson("/api/neta/auth/logout", {});
            router.refresh();
          }}
        >
          ログアウト
        </button>
      )}
    </div>
  );
}

function NameForm({ onDone }: { onDone: () => void }) {
  const { viewer, setDisplayName } = useNeta();
  const [name, setName] = useState(viewer?.displayName ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  return (
    <form
      className={s.nameForm}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const r = await postJson("/api/neta/me", { displayName: name }, "PATCH");
        setBusy(false);
        if (!r.ok) return setErr(errText(r.data));
        setDisplayName(String(r.data.displayName));
        onDone();
        router.refresh();
      }}
    >
      <input className={s.input} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder="表示する名前" autoFocus aria-label="表示する名前" />
      <button type="submit" className={s.primaryBtn} disabled={busy}>
        保存
      </button>
      <button type="button" className={s.linkBtn} onClick={onDone}>
        やめる
      </button>
      {err && <span className={s.err}>{err}</span>}
    </form>
  );
}

/** 聞きたいの数とボタン。書き込みが閉じているときは数だけ。 */
export function NetaVote({ topicId, stars: initialStars, voted: initialVoted }: { topicId: number; stars: number; voted: boolean }) {
  const { writable, requireLogin } = useNeta();
  const [stars, setStars] = useState(initialStars);
  const [voted, setVoted] = useState(initialVoted);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => {
    setStars(initialStars);
    setVoted(initialVoted);
  }, [initialStars, initialVoted]);

  if (!writable) {
    return (
      <div className={s.stars} aria-label={`聞きたい ${stars}`}>
        <div className={s.starsNum}>{stars}</div>
        <div className={s.starsLabel}>聞きたい</div>
      </div>
    );
  }
  const send = async (on: boolean) => {
    setBusy(true);
    setErr("");
    setVoted(on);
    setStars((n) => n + (on ? 1 : -1));
    const r = await postJson(`/api/neta/topics/${topicId}/vote`, { on });
    setBusy(false);
    if (r.ok) {
      setVoted(Boolean(r.data.voted));
      setStars(Number(r.data.stars));
    } else {
      setVoted(!on);
      setStars((n) => n + (on ? -1 : 1));
      setErr(errText(r.data));
    }
  };
  return (
    <div className={s.voteWrap}>
      <button
        type="button"
        className={`${s.vote} ${voted ? s.voteOn : ""}`}
        aria-pressed={voted}
        disabled={busy}
        onClick={() => requireLogin(() => send(!voted))}
        title={voted ? "聞きたいを外す" : "番組でこのネタを聞きたい"}
      >
        <span className={s.starsNum}>{stars}</span>
        <span className={s.starsLabel}>{voted ? "聞きたい済" : "聞きたい"}</span>
      </button>
      {err && <span className={s.errSmall}>{err}</span>}
    </div>
  );
}

/** メールだけでログイン（初めての人は backspace.fm の無料会員になる）。下から出るシート。 */
function LoginSheet({ onClose, onDone }: { onClose: () => void; onDone: (displayName: string | null) => void | Promise<void> }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/neta";
  return (
    <div className={s.sheetBack} onClick={onClose}>
      <div className={s.sheet} role="dialog" aria-modal="true" aria-labelledby="neta-login-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="neta-login-title" className={s.sheetTitle}>
          {step === "email" ? "メールアドレスで参加" : "メールのコードを入力"}
        </h2>
        {step === "email" ? (
          <form
            className={s.sheetForm}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr("");
              const r = await postJson("/api/neta/auth/request", { email, next });
              setBusy(false);
              if (!r.ok) return setErr(errText(r.data));
              setStep("code");
            }}
          >
            <p className={s.sheetText}>
              聞きたい・投稿・コメントは、メールアドレスだけで参加できます（無料）。初めての方は backspace.fm の無料会員として登録されます。ニュースレターは届きません。
            </p>
            <input
              className={s.input}
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
              aria-label="メールアドレス"
            />
            {err && <p className={s.err}>{err}</p>}
            <div className={s.sheetActions}>
              <button type="button" className={s.linkBtn} onClick={onClose}>
                やめる
              </button>
              <button type="submit" className={s.primaryBtn} disabled={busy || !email}>
                {busy ? "送っています…" : "コードを送る"}
              </button>
            </div>
          </form>
        ) : (
          <form
            className={s.sheetForm}
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr("");
              const r = await postJson("/api/neta/auth/verify", { email, code });
              if (!r.ok) {
                setBusy(false);
                return setErr(errText(r.data));
              }
              const m = r.data.member as { displayName?: string | null } | undefined;
              await onDone(m?.displayName ?? null);
            }}
          >
            <p className={s.sheetText}>
              {email} に 6 桁のコードを送りました。メールのボタンを押しても入れます。届かないときは迷惑メールのフォルダも見てください。
            </p>
            <input
              className={`${s.input} ${s.codeInput}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]*"
              maxLength={7}
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="123456"
              autoFocus
              aria-label="6 桁のコード"
            />
            {err && <p className={s.err}>{err}</p>}
            <div className={s.sheetActions}>
              <button type="button" className={s.linkBtn} onClick={() => setStep("email")}>
                アドレスを直す
              </button>
              <button type="submit" className={s.primaryBtn} disabled={busy || code.replace(/\s/g, "").length !== 6}>
                {busy ? "確かめています…" : "参加する"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/** 名前がまだなら、投稿・コメントの欄に名前の入力を出す。 */
function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>ネタ帳で表示する名前（公開されます）</span>
      <input className={s.input} value={value} maxLength={30} onChange={(e) => onChange(e.target.value)} required />
    </label>
  );
}

/** 今週にネタを投稿する（畳んでおき、押すと開く）。 */
export function NetaSubmit({ initial, startOpen = false }: { initial?: { url?: string; title?: string; description?: string }; startOpen?: boolean } = {}) {
  const { viewer, writable, requireLogin, setDisplayName } = useNeta();
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [url, setUrl] = useState(initial?.url ?? "");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [dup, setDup] = useState<{ id: number; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!writable) return null;
  if (!open) {
    return (
      <button type="button" className={s.submitOpen} onClick={() => requireLogin(() => setOpen(true))}>
        ＋ ネタを投稿する
      </button>
    );
  }
  const needName = !!viewer && !viewer.displayName;
  return (
    <form
      className={s.submitForm}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!viewer) return requireLogin();
        setBusy(true);
        setErr("");
        setDup(null);
        const r = await postJson("/api/neta/topics", { url, title, description, ...(needName ? { name } : {}) });
        setBusy(false);
        if (r.status === 409 && r.data.existing) {
          setDup(r.data.existing as { id: number; title: string });
          return setErr(errText(r.data));
        }
        if (!r.ok) return setErr(errText(r.data));
        if (needName) setDisplayName(name.trim());
        router.push(`/neta/t/${Number(r.data.id)}`);
      }}
    >
      <label className={s.field}>
        <span className={s.fieldLabel}>記事の URL</span>
        <input className={s.input} type="url" inputMode="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" autoFocus />
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>タイトル</span>
        <input className={s.input} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className={s.field}>
        <span className={s.fieldLabel}>ひとこと（なくても可）</span>
        <textarea className={s.textarea} rows={3} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </label>
      {needName && <NameField value={name} onChange={setName} />}
      {err && (
        <p className={s.err}>
          {err}
          {dup && (
            <>
              {" "}
              <Link href={`/neta/t/${dup.id}`}>「{dup.title}」を見る</Link>
            </>
          )}
        </p>
      )}
      <div className={s.sheetActions}>
        <button type="button" className={s.linkBtn} onClick={() => setOpen(false)}>
          やめる
        </button>
        <button type="submit" className={s.primaryBtn} disabled={busy}>
          {busy ? "送っています…" : viewer ? "投稿する" : "ログインして投稿する"}
        </button>
      </div>
    </form>
  );
}

/** コメントを書く。 */
export function NetaCommentForm({ topicId }: { topicId: number }) {
  const { viewer, writable, requireLogin, setDisplayName } = useNeta();
  const router = useRouter();
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  if (!writable) return null;
  if (!viewer) {
    return (
      <button type="button" className={s.submitOpen} onClick={() => requireLogin()}>
        コメントを書く
      </button>
    );
  }
  const needName = !viewer.displayName;
  return (
    <form
      className={s.submitForm}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr("");
        const r = await postJson(`/api/neta/topics/${topicId}/comments`, { body, ...(needName ? { name } : {}) });
        setBusy(false);
        if (!r.ok) return setErr(errText(r.data));
        if (needName) setDisplayName(name.trim());
        setBody("");
        router.refresh();
      }}
    >
      <label className={s.field}>
        <span className={s.fieldLabel}>コメント</span>
        <textarea className={s.textarea} rows={3} maxLength={1000} required value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      {needName && <NameField value={name} onChange={setName} />}
      {err && <p className={s.err}>{err}</p>}
      <div className={s.sheetActions}>
        <button type="submit" className={s.primaryBtn} disabled={busy || !body.trim()}>
          {busy ? "送っています…" : "コメントする"}
        </button>
      </div>
    </form>
  );
}

async function adminCall(url: string, method: string, body: unknown = {}): Promise<boolean> {
  const r = await postJson(url, body, method);
  if (!r.ok) window.alert(errText(r.data));
  return r.ok;
}

/** 管理者だけ: 採用（番組で話した）の切り替えと削除。 */
export function NetaTopicAdmin({ topicId, featured, afterDelete }: { topicId: number; featured: boolean; afterDelete?: string }) {
  const { admin } = useNeta();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  if (!admin) return null;
  return (
    <div className={s.adminRow}>
      <button
        type="button"
        className={s.adminBtn}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          if (await adminCall(`/api/neta/admin/topics/${topicId}`, "PATCH", { featured: !featured })) router.refresh();
          setBusy(false);
        }}
      >
        {featured ? "採用をやめる" : "🎙 採用"}
      </button>
      <button
        type="button"
        className={`${s.adminBtn} ${s.danger}`}
        disabled={busy}
        onClick={async () => {
          if (!window.confirm("このネタを消しますか？聞きたいとコメントも消え、元に戻せません")) return;
          setBusy(true);
          if (await adminCall(`/api/neta/admin/topics/${topicId}`, "DELETE")) {
            if (afterDelete) router.push(afterDelete);
            else router.refresh();
          }
          setBusy(false);
        }}
      >
        削除
      </button>
    </div>
  );
}

/** 管理者だけ: コメントの削除。 */
export function NetaCommentDelete({ commentId }: { commentId: number }) {
  const { admin } = useNeta();
  const router = useRouter();
  if (!admin) return null;
  return (
    <button
      type="button"
      className={`${s.linkBtn} ${s.danger}`}
      onClick={async () => {
        if (!window.confirm("このコメントを消しますか？元に戻せません")) return;
        if (await adminCall(`/api/neta/admin/comments/${commentId}`, "DELETE")) router.refresh();
      }}
    >
      削除
    </button>
  );
}
