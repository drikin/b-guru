"use client";
/* 📜 台本（単独の機能、2026-11-14 オーナー）。B-guru の中（サイドバーの 📜 台本、メインの列）とアプリのタブ（/neta/app/script）。
 * - 読めるのは有料会員。直す・作り直す・チェック欄を押すのは管理者（出演者）だけ。
 * - 見る画面は Markdown を整えて出す。「- [ ] 」は ☐ で、管理者が押すと ☑ に（サーバで 1 か所だけ書き換える）。
 * - 見ている間は 20 秒ごとに読み直す（ほかの出演者のチェックや保存が見える）。直している間は読み直さない。
 * - 保存は読んだときの版と比べる。ほかの人が先に保存していたら、相手の版を読むか、自分の版で上書きするかを選ぶ。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { mdToHtml } from "@/lib/md";
import { checksToMarks } from "@/lib/neta-script";
import s from "./neta.module.css";
import c from "./script.module.css";

type Doc = { content: string; updatedBy: string | null; updatedAt: string };
type Week = { id: number; title: string; isActive: boolean; hasScript: boolean; featured: number };
type Data = { admin: boolean; weeks: Week[]; weekId: number | null; script: Doc | null };

/** アプリのタブでログインが切れたら、アプリに入り直しを頼む（NetaClient と同じ）。 */
const REENTER = "bguru-neta://reenter";
const POLL_MS = 20_000;

async function call(url: string, method = "GET", body?: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, {
      method,
      cache: "no-store",
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: r.ok, status: r.status, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, status: 0, data: { error: "通信できませんでした" } };
  }
}
const errOf = (d: Record<string, unknown>) => (typeof d.error === "string" ? d.error : "うまくいきませんでした");

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const isCheckLi = (li: Element) => /^\s*[☐☑]/.test(li.textContent || "");

export default function ScriptBoard({ app = false }: { app?: boolean }) {
  const [data, setData] = useState<Data | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "login" | "error">("loading");
  const [weekId, setWeekId] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null); // null = 見る画面
  const [base, setBase] = useState<string | null>(null); // 直し始めたときの版
  const [conflict, setConflict] = useState<Doc | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [discardAsk, setDiscardAsk] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const editing = draft !== null;

  const load = useCallback(
    async (week: number | null, quiet = false) => {
      const r = await call(`/api/script${week != null ? `?week=${week}` : ""}`);
      if (r.status === 401) {
        if (app) window.location.href = REENTER;
        setState("login");
        return;
      }
      if (!r.ok) {
        if (!quiet) setState("error");
        return;
      }
      const d = r.data as unknown as Data;
      setData(d);
      setWeekId(d.weekId);
      setState("ok");
    },
    [app]
  );

  useEffect(() => {
    const t = window.setTimeout(() => void load(null), 0);
    return () => window.clearTimeout(t);
  }, [load]);

  // 見ている間だけ読み直す。
  useEffect(() => {
    if (editing || state !== "ok") return;
    const t = window.setInterval(() => {
      if (document.visibilityState === "visible") void load(weekId, true);
    }, POLL_MS);
    const onVis = () => document.visibilityState === "visible" && void load(weekId, true);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [editing, state, weekId, load]);

  // 保存していない変更があるときは、ページを離れる前に止める（ブラウザの標準の確認）。
  useEffect(() => {
    if (!editing) return;
    const h = (e: BeforeUnloadEvent) => {
      if (draft !== (data?.script?.content ?? "")) e.preventDefault();
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [editing, draft, data]);

  const week = data?.weeks.find((w) => w.id === weekId) ?? null;
  const script = data?.script ?? null;
  const admin = !!data?.admin;
  const html = useMemo(() => (script ? mdToHtml(checksToMarks(script.content)) : ""), [script]);

  // チェック欄の li に印を付ける（押せる見た目・数え方）。
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    el.querySelectorAll("li").forEach((li) => {
      if (isCheckLi(li)) li.setAttribute("data-check", /^\s*☑/.test(li.textContent || "") ? "on" : "off");
    });
  }, [html, editing]);

  const startEdit = (content: string) => {
    setBase(script?.updatedAt ?? null);
    setDraft(content);
    setConflict(null);
    setDiscardAsk(false);
    setMsg("");
  };

  const save = async (over?: string | null) => {
    if (draft === null || !week) return;
    setBusy(true);
    const r = await call(`/api/script/${week.id}`, "PUT", { content: draft, base: over !== undefined ? over : base });
    setBusy(false);
    if (r.status === 409) {
      setConflict((r.data.script as Doc | null) ?? null);
      setMsg(errOf(r.data));
      return;
    }
    if (!r.ok) return setMsg(errOf(r.data));
    const doc = r.data.script as Doc;
    setData((d) => (d ? { ...d, script: doc, weeks: d.weeks.map((w) => (w.id === week.id ? { ...w, hasScript: true } : w)) } : d));
    setDraft(null);
    setConflict(null);
    setMsg(`保存しました（${when(doc.updatedAt)}）`);
  };

  const regenerate = async () => {
    if (!week) return;
    setBusy(true);
    const r = await call(`/api/script/${week.id}`, "POST", {});
    setBusy(false);
    if (!r.ok) return setMsg(errOf(r.data));
    if (editing) {
      setDraft(String(r.data.content));
      setMsg("採用ネタで作り直しました。よければ保存してください");
    } else {
      startEdit(String(r.data.content));
      setMsg("採用ネタで作り直しました。よければ保存してください");
    }
  };

  const onViewClick = async (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (t.closest("a")) return;
    const li = t.closest("li");
    if (!admin || !li || !week || !isCheckLi(li) || busy) return;
    const all = Array.from(viewRef.current?.querySelectorAll("li") ?? []).filter(isCheckLi);
    const n = all.indexOf(li);
    if (n < 0) return;
    li.setAttribute("data-check", li.getAttribute("data-check") === "on" ? "off" : "on"); // 先に見た目だけ
    setBusy(true);
    const r = await call(`/api/script/${week.id}`, "PATCH", { check: n });
    setBusy(false);
    if (r.ok) {
      const doc = r.data.script as Doc;
      setData((d) => (d ? { ...d, script: doc } : d));
    } else {
      setMsg(errOf(r.data));
      void load(week.id, true);
    }
  };

  const copy = async () => {
    const text = draft ?? script?.content ?? "";
    try {
      await navigator.clipboard.writeText(text);
      setMsg("台本をコピーしました");
    } catch {
      setMsg("コピーできませんでした");
    }
  };

  if (state === "loading") return <p className={s.count}>読み込んでいます…</p>;
  if (state === "login")
    return (
      <div className={c.wrap}>
        <h1 className={c.title}>📜 台本</h1>
        <p className={s.notice}>BSM 会員限定です。B-guru にログインすると読めます。</p>
      </div>
    );
  if (state === "error" || !data)
    return (
      <div className={c.wrap}>
        <p className={s.err}>台本を読めませんでした。</p>
        <button type="button" className={s.adminBtn} onClick={() => load(weekId)}>
          もう一度
        </button>
      </div>
    );

  const dirty = editing && draft !== (script?.content ?? "");
  return (
    <div className={c.wrap}>
      <div className={c.head}>
        <h1 className={c.title}>📜 台本</h1>
        <select
          className={c.week}
          value={weekId ?? ""}
          disabled={editing}
          aria-label="週"
          onChange={(e) => {
            const id = Number(e.target.value);
            setWeekId(id);
            setMsg("");
            void load(id);
          }}
        >
          {data.weeks.map((w) => (
            <option key={w.id} value={w.id}>
              {w.title}
              {w.isActive ? "（今週）" : ""}
              {w.hasScript ? "" : " ・台本なし"}
            </option>
          ))}
        </select>
      </div>

      {!week ? (
        <p className={s.count}>まだ週がありません。</p>
      ) : (
        <>
          <div className={c.bar}>
            {script && !editing && (
              <span className={s.count}>
                {when(script.updatedAt)}
                {script.updatedBy ? ` ${script.updatedBy}` : ""}
              </span>
            )}
            <span className={c.spacer} />
            {(script || editing) && (
              <button type="button" className={s.adminBtn} onClick={copy}>
                コピー
              </button>
            )}
            {admin && (
              <button type="button" className={s.adminBtn} disabled={busy} onClick={regenerate}>
                採用ネタで作り直す（{week.featured} 件）
              </button>
            )}
            {admin && !editing && script && (
              <button type="button" className={s.primaryBtn} onClick={() => startEdit(script.content)}>
                編集
              </button>
            )}
          </div>
          {msg && <p className={c.msg}>{msg}</p>}

          {conflict && editing && (
            <div className={s.notice}>
              <div>
                {conflict.updatedBy ?? "ほかの人"}さんが {when(conflict.updatedAt)} に保存した版があります。
              </div>
              <div className={c.row}>
                <button
                  type="button"
                  className={s.adminBtn}
                  onClick={() => {
                    setData((d) => (d ? { ...d, script: conflict } : d));
                    setDraft(null);
                    setConflict(null);
                    setMsg("相手の版を読みました（自分の変更は捨てました）");
                  }}
                >
                  相手の版を読む（自分の変更を捨てる）
                </button>
                <button type="button" className={s.adminBtn} disabled={busy} onClick={() => save(conflict.updatedAt)}>
                  自分の版で上書き
                </button>
                <button type="button" className={s.adminBtn} onClick={copy}>
                  自分の版をコピー
                </button>
              </div>
            </div>
          )}

          {editing ? (
            <>
              <textarea
                className={`${s.textarea} ${s.scriptArea}`}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDiscardAsk(false);
                }}
                spellCheck={false}
                aria-label="台本"
              />
              <div className={s.sheetActions}>
                {dirty && <span className={s.count}>保存していない変更があります</span>}
                {discardAsk ? (
                  <>
                    <span className={s.count}>変更を捨てますか？</span>
                    <button
                      type="button"
                      className={s.adminBtn}
                      onClick={() => {
                        setDraft(null);
                        setConflict(null);
                        setDiscardAsk(false);
                        setMsg("");
                      }}
                    >
                      捨てる
                    </button>
                    <button type="button" className={s.adminBtn} onClick={() => setDiscardAsk(false)}>
                      やめる
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className={s.adminBtn}
                    onClick={() => {
                      if (dirty) return setDiscardAsk(true);
                      setDraft(null);
                      setConflict(null);
                      setMsg("");
                    }}
                  >
                    キャンセル
                  </button>
                )}
                <button type="button" className={s.primaryBtn} disabled={busy || !dirty || !draft.trim()} onClick={() => save()}>
                  保存
                </button>
              </div>
            </>
          ) : script ? (
            <div
              ref={viewRef}
              className={`${c.doc} ${admin ? c.canCheck : ""}`}
              onClick={onViewClick}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <div className={s.topicBox}>
              <p className={s.count}>
                {admin ? "この週の台本はまだありません。「採用ネタで作り直す」で、前の週の台本をもとに作れます。" : "この週の台本はまだありません。"}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
