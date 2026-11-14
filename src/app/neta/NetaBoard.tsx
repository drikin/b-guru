"use client";
/* 📝 B-guru の中（メインの列）に出すネタ帳。/neta のページと同じ見た目を、ページを移らずに切り替える。
 * 読み出しは /api/neta/board と /api/neta/topic/<id>（誰でも読める・メールアドレスは来ない）。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { netaDate, netaHost, netaLiveDate, netaPreview, netaSafeHref, type NetaComment, type NetaSort, type NetaTopic, type NetaWeek } from "@/lib/neta-format";
import {
  NetaAccount,
  NetaCommentDelete,
  NetaCommentForm,
  NetaProvider,
  NetaSubmit,
  NetaTopicAdmin,
  NetaVote,
  type ClientViewer,
  type NetaNav,
} from "./NetaClient";
import s from "./neta.module.css";

type Me = { viewer: ClientViewer; writable: boolean; admin: boolean; live: boolean };
type BoardData = Me & { week: NetaWeek | null; current: NetaWeek | null; weeks: NetaWeek[]; total: number; topics: (NetaTopic & { voted: boolean })[] };
type TopicData = Me & { topic: NetaTopic; week: NetaWeek | null; comments: NetaComment[]; voted: boolean };

type View = { kind: "week"; weekId: number | null; sort: NetaSort } | { kind: "topic"; id: number };

/** /neta・/neta/w/<id>・/neta/t/<id>（?sort=new）を画面の切り替えに読み替える。 */
export function parseNetaHref(href: string): View | null {
  let u: URL;
  try {
    u = new URL(href, "https://bsm.backspace.fm");
  } catch {
    return null;
  }
  const sort: NetaSort = u.searchParams.get("sort") === "new" ? "new" : "stars";
  const t = /^\/neta\/t\/(\d{1,9})\/?$/.exec(u.pathname);
  if (t) return { kind: "topic", id: Number(t[1]) };
  const w = /^\/neta\/w\/(\d{1,9})\/?$/.exec(u.pathname);
  if (w) return { kind: "week", weekId: Number(w[1]), sort };
  if (/^\/neta\/?$/.test(u.pathname)) return { kind: "week", weekId: null, sort };
  return null;
}

function hrefOf(v: View): string {
  if (v.kind === "topic") return `/neta/t/${v.id}`;
  const base = v.weekId == null ? "/neta" : `/neta/w/${v.weekId}`;
  return v.sort === "new" ? `${base}?sort=new` : base;
}

/** a のクリックを画面の切り替えに（新しいタブで開く操作はそのまま）。 */
function InLink({ href, go, className, children }: { href: string; go: (h: string) => void; className?: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(href);
      }}
    >
      {children}
    </a>
  );
}

/** app: B-guru のアプリの 📝 タブ（/neta/app）。 */
export default function NetaBoard({ app = false }: { app?: boolean }) {
  const [view, setView] = useState<View>({ kind: "week", weekId: null, sort: "stars" });
  const [board, setBoard] = useState<BoardData | null>(null);
  const [topic, setTopic] = useState<TopicData | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    setError("");
    const url =
      view.kind === "topic"
        ? `/api/neta/topic/${view.id}`
        : `/api/neta/board?${new URLSearchParams({ ...(view.weekId != null ? { week: String(view.weekId) } : {}), sort: view.sort })}`;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) return setError(typeof d.error === "string" ? d.error : "読み込めませんでした");
        if (view.kind === "topic") setTopic(d as TopicData);
        else setBoard(d as BoardData);
      })
      .catch(() => alive && setError("通信できませんでした"));
    return () => {
      alive = false;
    };
  }, [view, tick]);

  const go = useCallback((href: string) => {
    const v = parseNetaHref(href);
    if (v) {
      setView(v);
      window.scrollTo({ top: 0 });
    } else window.location.href = href;
  }, []);
  const nav: NetaNav = useMemo(() => ({ refresh: () => setTick((n) => n + 1), go }), [go]);

  const me: Me | null = view.kind === "topic" ? topic : board;
  if (!me) return <p className={s.empty}>{error || "読み込んでいます…"}</p>;

  return (
    <NetaProvider viewer={me.viewer} writable={me.writable} admin={me.admin} nav={nav} app={app}>
      <div className={s.inApp}>
        <header className={s.brand}>
          <InLink href="/neta" go={go}>
            <div className={s.brandName}>📝 backspace.fm のネタ帳</div>
            <div className={s.brandSub}>番組で話してほしいネタを、みんなで投稿して投票する場所</div>
          </InLink>
          <NetaAccount />
        </header>
        {!me.live && (
          <p className={s.notice}>
            いまは試験公開中です。ネタの投稿と「聞きたい」は、これまでどおり{" "}
            <a href="https://neta.backspace.fm" target="_blank" rel="noopener noreferrer">
              neta.backspace.fm
            </a>{" "}
            でどうぞ。
          </p>
        )}
        {error && <p className={s.err}>{error}</p>}
        {view.kind === "topic" && topic ? <TopicView data={topic} go={go} /> : board ? <WeekView data={board} sort={view.kind === "week" ? view.sort : "stars"} go={go} /> : null}
      </div>
    </NetaProvider>
  );
}

function WeekView({ data, sort, go }: { data: BoardData; sort: NetaSort; go: (h: string) => void }) {
  const { week, current, weeks, topics, total } = data;
  if (!week) return <p className={s.empty}>まだ週がありません</p>;
  const isCurrent = current?.id === week.id;
  const wh = (w: NetaWeek, so: NetaSort) => hrefOf({ kind: "week", weekId: current && w.id === current.id ? null : w.id, sort: so });
  return (
    <>
      <section className={s.weekHead}>
        <h1 className={s.weekTitle}>{week.title || "（題名なし）"}</h1>
        <div className={s.weekMeta}>
          {isCurrent && <span>今週のネタ</span>}
          <span>
            {week.startDate} 〜 {week.endDate}
          </span>
          {week.liveRecordingDate && <span>ライブ収録: {netaLiveDate(week.liveRecordingDate)}</span>}
          {week.liveUrl && /^https?:\/\//i.test(week.liveUrl) && (
            <a href={week.liveUrl} target="_blank" rel="noopener noreferrer">
              ライブ配信を開く
            </a>
          )}
        </div>
      </section>
      {isCurrent && <NetaSubmit />}
      <div className={s.bar}>
        <nav className={s.tabs} aria-label="並べ方">
          <InLink href={wh(week, "stars")} go={go} className={`${s.tab} ${sort === "stars" ? s.tabOn : ""}`}>
            聞きたい順
          </InLink>
          <InLink href={wh(week, "new")} go={go} className={`${s.tab} ${sort === "new" ? s.tabOn : ""}`}>
            新しい順
          </InLink>
        </nav>
        <span className={s.count}>ネタ {total} 件</span>
      </div>
      <details className={s.weeks}>
        <summary>ほかの週を見る</summary>
        <ul className={s.weekList}>
          {weeks.map((w) => (
            <li key={w.id}>
              <InLink href={wh(w, sort)} go={go} className={w.id === week.id ? s.weekNow : undefined}>
                {w.title || `${w.startDate} の週`}
                {current?.id === w.id ? "（今週）" : ""}
              </InLink>
            </li>
          ))}
        </ul>
      </details>
      {topics.length === 0 ? (
        <p className={s.empty}>この週のネタはまだありません</p>
      ) : (
        <ol className={s.list}>
          {topics.map((t, i) => {
            const host = netaHost(t.url);
            const preview = netaPreview(t.description);
            return (
              <li key={t.id} className={s.item}>
                <span className={s.rank}>{sort === "stars" ? i + 1 : ""}</span>
                <div className={s.main}>
                  <InLink href={`/neta/t/${t.id}`} go={go} className={s.title}>
                    {t.title}
                  </InLink>
                  <div className={s.sub}>
                    {t.featured && <span className={s.featured}>🎙 番組で話した</span>}
                    {host && <span>{host}</span>}
                    <span>{t.submitter}</span>
                    <span>{netaDate(t.createdAt)}</span>
                    {t.comments > 0 && <span>コメント {t.comments}</span>}
                  </div>
                  {preview && <p className={s.desc}>{preview}</p>}
                  <NetaTopicAdmin topicId={t.id} featured={t.featured} />
                </div>
                <NetaVote topicId={t.id} stars={t.stars} voted={t.voted} />
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

function TopicView({ data, go }: { data: TopicData; go: (h: string) => void }) {
  const { topic, week, comments, voted } = data;
  const href = netaSafeHref(topic.url);
  const host = netaHost(topic.url);
  const back = week && !week.isActive ? `/neta/w/${week.id}` : "/neta";
  return (
    <>
      <div className={s.back}>
        <InLink href={back} go={go}>
          ← {week?.title || "ネタ帳"} のランキング
        </InLink>
      </div>
      <div className={s.topicHead}>
        <div className={s.main}>
          <h1 className={s.topicTitle}>{topic.title}</h1>
          <div className={s.sub}>
            {topic.featured && <span className={s.featured}>🎙 番組で話した</span>}
            <span>{topic.submitter}</span>
            <span>{netaDate(topic.createdAt)}</span>
            <a href={`/neta/t/${topic.id}`} target="_blank" rel="noopener noreferrer">
              共有用のページ
            </a>
          </div>
          <NetaTopicAdmin topicId={topic.id} featured={topic.featured} afterDelete={back} />
        </div>
        <NetaVote topicId={topic.id} stars={topic.stars} voted={voted} />
      </div>
      <div className={s.topicBox}>
        <p className={s.topicDesc}>{topic.description || "（説明なし）"}</p>
        {href && (
          <a className={s.open} href={href} target="_blank" rel="noopener noreferrer nofollow">
            記事を開く{host ? `（${host}）` : ""}
          </a>
        )}
      </div>
      <h2 className={s.sectionTitle}>コメント {comments.length > 0 ? comments.length : ""}</h2>
      {comments.length === 0 ? (
        <p className={s.count}>まだコメントはありません</p>
      ) : (
        <ul className={s.comments}>
          {comments.map((c) => (
            <li key={c.id} className={s.comment}>
              <div className={s.commentHead}>
                {c.commenter} ・ {netaDate(c.createdAt)} <NetaCommentDelete commentId={c.id} />
              </div>
              <p className={s.commentBody}>{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <NetaCommentForm topicId={topic.id} />
    </>
  );
}
