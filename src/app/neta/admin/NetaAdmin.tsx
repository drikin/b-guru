"use client";
/* 📝 ネタ帳の管理画面の操作。 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import s from "../neta.module.css";

export type AdminWeek = {
  id: number;
  title: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
  liveRecordingDate: string | null;
  liveUrl: string | null;
  topics: number;
  featured: number;
  episode: number | null;
};

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const r = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { ok: r.ok, data: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { error: "通信できませんでした" } };
  }
}
const err = (d: Record<string, unknown>) => (typeof d.error === "string" ? d.error : "うまくいきませんでした");

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

type Form = { title: string; startDate: string; endDate: string; liveRecordingDate: string; liveUrl: string };

function WeekForm({ initial, submitLabel, onSubmit, onCancel }: { initial: Form; submitLabel: string; onSubmit: (f: Form) => Promise<string | null>; onCancel?: () => void }) {
  const [f, setF] = useState(initial);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form
      className={s.submitForm}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const m = await onSubmit(f);
        setBusy(false);
        setMsg(m ?? "");
      }}
    >
      <label className={s.field}>
        <span className={s.fieldLabel}>題名（例: ep681）</span>
        <input className={s.input} required maxLength={100} value={f.title} onChange={set("title")} />
      </label>
      <div className={s.adminGrid}>
        <label className={s.field}>
          <span className={s.fieldLabel}>始まり</span>
          <input className={s.input} type="date" required value={f.startDate} onChange={set("startDate")} />
        </label>
        <label className={s.field}>
          <span className={s.fieldLabel}>終わり</span>
          <input className={s.input} type="date" required value={f.endDate} onChange={set("endDate")} />
        </label>
      </div>
      <div className={s.adminGrid}>
        <label className={s.field}>
          <span className={s.fieldLabel}>ライブ収録（なくても可）</span>
          <input className={s.input} type="datetime-local" value={f.liveRecordingDate} onChange={set("liveRecordingDate")} />
        </label>
        <label className={s.field}>
          <span className={s.fieldLabel}>ライブ配信の URL（なくても可）</span>
          <input className={s.input} type="url" value={f.liveUrl} onChange={set("liveUrl")} placeholder="https://" />
        </label>
      </div>
      {msg && <p className={s.err}>{msg}</p>}
      <div className={s.sheetActions}>
        {onCancel && (
          <button type="button" className={s.linkBtn} onClick={onCancel}>
            やめる
          </button>
        )}
        <button type="submit" className={s.primaryBtn} disabled={busy}>
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

function toForm(w: AdminWeek): Form {
  return { title: w.title, startDate: w.startDate, endDate: w.endDate, liveRecordingDate: w.liveRecordingDate ?? "", liveUrl: w.liveUrl ?? "" };
}

/** 台本とタイトル案（選んだ週）。 */
function WeekTools({ week }: { week: AdminWeek }) {
  const [content, setContent] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [titles, setTitles] = useState<{ title: string; reasoning: string }[] | null>(null);
  const [titleMsg, setTitleMsg] = useState("");

  useEffect(() => {
    let alive = true;
    setContent(null);
    setTitles(null);
    setInfo("");
    (async () => {
      const r = await call(`/api/neta/admin/scripts/${week.id}`, "GET");
      if (!alive) return;
      const sc = r.data.script as { content: string; updatedBy: string | null; updatedAt: string } | null;
      setContent(sc?.content ?? "");
      setSaved(sc?.content ?? "");
      setInfo(sc ? `最後の保存: ${new Date(sc.updatedAt).toLocaleString("ja-JP")}${sc.updatedBy ? `（${sc.updatedBy}）` : ""}` : "まだ台本がありません。「採用ネタで作り直す」で作れます");
    })();
    return () => {
      alive = false;
    };
  }, [week.id]);

  const dirty = content !== null && content !== saved;
  return (
    <section className={s.adminSection}>
      <h2 className={s.sectionTitle}>
        {week.title} の台本 {week.isActive && <span className={s.featured}>今週</span>}
      </h2>
      <p className={s.count}>{info}</p>
      <div className={s.adminRow}>
        <button
          type="button"
          className={s.adminBtn}
          disabled={busy}
          onClick={async () => {
            if (dirty && !window.confirm("保存していない変更があります。採用ネタで作り直しますか？")) return;
            setBusy(true);
            const r = await call(`/api/neta/admin/scripts/${week.id}`, "POST", {});
            setBusy(false);
            if (r.ok) setContent(String(r.data.content));
            else window.alert(err(r.data));
          }}
        >
          採用ネタで作り直す（{week.featured} 件）
        </button>
        <button
          type="button"
          className={s.adminBtn}
          disabled={!content}
          onClick={async () => setInfo((await copy(content ?? "")) ? "台本をコピーしました" : "コピーできませんでした")}
        >
          コピー
        </button>
        <button
          type="button"
          className={s.adminBtn}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setTitleMsg("考えています…");
            const r = await call(`/api/neta/admin/titles/${week.id}`, "POST", {});
            setBusy(false);
            if (r.ok) {
              setTitles(r.data.suggestions as { title: string; reasoning: string }[]);
              setTitleMsg("");
            } else setTitleMsg(err(r.data));
          }}
        >
          ✨ タイトル案
        </button>
      </div>
      {(titles || titleMsg) && (
        <div className={s.topicBox}>
          {titleMsg && <p className={s.count}>{titleMsg}</p>}
          {titles && (
            <ol className={s.titleList}>
              {titles.map((t, i) => (
                <li key={i}>
                  <button type="button" className={s.titlePick} onClick={async () => setTitleMsg((await copy(t.title)) ? `「${t.title}」をコピーしました` : "コピーできませんでした")}>
                    {t.title}
                  </button>
                  {t.reasoning && <div className={s.count}>{t.reasoning}</div>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {content === null ? (
        <p className={s.count}>読み込んでいます…</p>
      ) : (
        <>
          <textarea className={`${s.textarea} ${s.scriptArea}`} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} aria-label="台本" />
          <div className={s.sheetActions}>
            {dirty && <span className={s.count}>保存していない変更があります</span>}
            <button
              type="button"
              className={s.primaryBtn}
              disabled={busy || !dirty || !content.trim()}
              onClick={async () => {
                setBusy(true);
                const r = await call(`/api/neta/admin/scripts/${week.id}`, "PUT", { content });
                setBusy(false);
                if (!r.ok) return window.alert(err(r.data));
                setSaved(content);
                setInfo(`保存しました（${new Date().toLocaleTimeString("ja-JP")}）`);
              }}
            >
              台本を保存
            </button>
          </div>
        </>
      )}
    </section>
  );
}

export default function NetaAdmin({ weeks }: { weeks: AdminWeek[] }) {
  const router = useRouter();
  const active = weeks.find((w) => w.isActive) ?? weeks[0] ?? null;
  const [selected, setSelected] = useState<number | null>(active?.id ?? null);
  const [editing, setEditing] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const sel = weeks.find((w) => w.id === selected) ?? null;

  const nextForm = useMemo<Form>(() => {
    const latest = weeks[0];
    const n = weeks.map((w) => w.episode ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const start = latest?.endDate || new Date().toISOString().slice(0, 10);
    return { title: n ? `ep${n + 1}` : "", startDate: start, endDate: addDays(start, 7), liveRecordingDate: "", liveUrl: "" };
  }, [weeks]);

  return (
    <>
      <section className={s.adminSection}>
        <div className={s.bar}>
          <h2 className={s.sectionTitle}>週</h2>
          <div className={s.adminRow}>
            <a className={s.adminBtn} href="/api/neta/admin/export">
              書き出し（JSON）
            </a>
            {!creating && (
              <button type="button" className={s.adminBtn} onClick={() => setCreating(true)}>
                ＋ 新しい週
              </button>
            )}
          </div>
        </div>
        {creating && (
          <WeekForm
            initial={nextForm}
            submitLabel="週を作る"
            onCancel={() => setCreating(false)}
            onSubmit={async (f) => {
              const r = await call("/api/neta/admin/weeks", "POST", f);
              if (!r.ok) return err(r.data);
              setCreating(false);
              setSelected(Number(r.data.id));
              router.refresh();
              return null;
            }}
          />
        )}
        <ul className={s.adminWeeks}>
          {weeks.map((w) => (
            <li key={w.id} className={`${s.adminWeek} ${w.id === selected ? s.adminWeekOn : ""}`}>
              {editing === w.id ? (
                <WeekForm
                  initial={toForm(w)}
                  submitLabel="保存"
                  onCancel={() => setEditing(null)}
                  onSubmit={async (f) => {
                    const r = await call(`/api/neta/admin/weeks/${w.id}`, "PATCH", f);
                    if (!r.ok) return err(r.data);
                    setEditing(null);
                    router.refresh();
                    return null;
                  }}
                />
              ) : (
                <>
                  <button type="button" className={s.adminWeekMain} onClick={() => setSelected(w.id)}>
                    <span className={s.adminWeekTitle}>
                      {w.title} {w.isActive && <span className={s.featured}>今週</span>}
                    </span>
                    <span className={s.count}>
                      {w.startDate} 〜 {w.endDate} ・ ネタ {w.topics} ・ 採用 {w.featured}
                    </span>
                  </button>
                  <div className={s.adminRow}>
                    <Link className={s.adminBtn} href={w.isActive ? "/neta" : `/neta/w/${w.id}`}>
                      ランキング
                    </Link>
                    {!w.isActive && (
                      <button
                        type="button"
                        className={s.adminBtn}
                        onClick={async () => {
                          if (!window.confirm(`${w.title} を今週にしますか？新しい投稿はこの週に入ります`)) return;
                          const r = await call(`/api/neta/admin/weeks/${w.id}`, "PATCH", { active: true });
                          if (!r.ok) return window.alert(err(r.data));
                          router.refresh();
                        }}
                      >
                        今週にする
                      </button>
                    )}
                    <button type="button" className={s.adminBtn} onClick={() => setEditing(w.id)}>
                      編集
                    </button>
                    {!w.isActive && w.topics === 0 && (
                      <button
                        type="button"
                        className={`${s.adminBtn} ${s.danger}`}
                        onClick={async () => {
                          if (!window.confirm(`${w.title} を消しますか？台本も消えます`)) return;
                          const r = await call(`/api/neta/admin/weeks/${w.id}`, "DELETE", {});
                          if (!r.ok) return window.alert(err(r.data));
                          router.refresh();
                        }}
                      >
                        削除
                      </button>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </section>
      {sel && <WeekTools week={sel} />}
    </>
  );
}
