/* 📝 ネタ帳の 1 週分のランキング（/neta と /neta/w/<id> で共通、サーバで描画）。 */
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  countTopics, getCurrentWeek, getWeek, listTopics, listWeeks, netaDate, netaHost, netaLiveDate, netaPreview, type NetaSort, type NetaWeek,
} from "@/lib/neta-board";
import { votedTopicIds } from "@/lib/neta-write";
import { NetaProvider, NetaSubmit, NetaTopicAdmin, NetaVote } from "./NetaClient";
import { loadNetaViewer, NetaFooter, NetaHeader } from "./parts";
import s from "./neta.module.css";

export function weekHref(week: NetaWeek, current: NetaWeek | null, sort: NetaSort): string {
  const base = current && week.id === current.id ? "/neta" : `/neta/w/${week.id}`;
  return sort === "new" ? `${base}?sort=new` : base;
}

export async function loadWeek(weekId: number | null): Promise<{ week: NetaWeek; current: NetaWeek | null } | null> {
  const current = await getCurrentWeek();
  const week = weekId == null ? current : await getWeek(weekId);
  return week ? { week, current } : null;
}

export default async function WeekBoard({ weekId, sort }: { weekId: number | null; sort: NetaSort }) {
  const loaded = await loadWeek(weekId);
  const { viewer, writable, memberId, admin } = await loadNetaViewer();
  if (!loaded) {
    if (weekId != null) notFound();
    return (
      <NetaProvider viewer={viewer} writable={writable} admin={admin}>
        <main className={s.page}>
          <NetaHeader writable={writable} />
          <p className={s.empty}>まだ週がありません</p>
          <NetaFooter />
        </main>
      </NetaProvider>
    );
  }
  const { week, current } = loaded;
  const [topics, total, weeks] = await Promise.all([listTopics(week.id, sort), countTopics(week.id), listWeeks()]);
  const voted = await votedTopicIds(memberId, topics.map((t) => t.id));
  const isCurrent = current?.id === week.id;
  return (
    <NetaProvider viewer={viewer} writable={writable} admin={admin}>
    <main className={s.page}>
      <NetaHeader writable={writable} />
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
          <Link href={weekHref(week, current, "stars")} className={`${s.tab} ${sort === "stars" ? s.tabOn : ""}`}>
            聞きたい順
          </Link>
          <Link href={weekHref(week, current, "new")} className={`${s.tab} ${sort === "new" ? s.tabOn : ""}`}>
            新しい順
          </Link>
        </nav>
        <span className={s.count}>ネタ {total} 件</span>
      </div>

      <details className={s.weeks}>
        <summary>ほかの週を見る</summary>
        <ul className={s.weekList}>
          {weeks.map((w) => (
            <li key={w.id}>
              <Link href={weekHref(w, current, sort)} className={w.id === week.id ? s.weekNow : undefined}>
                {w.title || `${w.startDate} の週`}
                {current?.id === w.id ? "（今週）" : ""}
              </Link>
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
                  <Link href={`/neta/t/${t.id}`} className={s.title}>
                    {t.title}
                  </Link>
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
                <NetaVote topicId={t.id} stars={t.stars} voted={voted.has(t.id)} />
              </li>
            );
          })}
        </ol>
      )}
      <NetaFooter />
    </main>
    </NetaProvider>
  );
}
