/* 📝 /neta/t/<話題の id> — 1 つのネタ（説明・コメント）。 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getTopic, netaDate, netaHost, netaPreview, netaSafeHref } from "@/lib/neta-board";
import { votedTopicIds } from "@/lib/neta-write";
import { NetaCommentDelete, NetaCommentForm, NetaProvider, NetaTopicAdmin, NetaVote } from "../../NetaClient";
import { loadNetaViewer, NetaFooter, NetaHeader } from "../../parts";
import s from "../../neta.module.css";

function topicId(raw: string): number {
  return /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  await connection();
  const got = await getTopic(topicId((await params).id));
  if (!got) return {};
  const description = netaPreview(got.topic.description, 120) || `聞きたい ${got.topic.stars}`;
  return { title: got.topic.title, description, openGraph: { title: got.topic.title, description } };
}

export default async function NetaTopicPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const got = await getTopic(topicId((await params).id));
  if (!got) notFound();
  const { topic, week, comments } = got;
  const href = netaSafeHref(topic.url);
  const host = netaHost(topic.url);
  const { viewer, writable, memberId, admin } = await loadNetaViewer();
  const voted = (await votedTopicIds(memberId, [topic.id])).has(topic.id);
  return (
    <NetaProvider viewer={viewer} writable={writable} admin={admin}>
    <main className={s.page}>
      <NetaHeader writable={writable} />
      <div className={s.back}>
        <Link href={week && !week.isActive ? `/neta/w/${week.id}` : "/neta"}>← {week?.title || "ネタ帳"} のランキング</Link>
      </div>
      <div className={s.topicHead}>
        <div className={s.main}>
          <h1 className={s.topicTitle}>{topic.title}</h1>
          <div className={s.sub}>
            {topic.featured && <span className={s.featured}>🎙 番組で話した</span>}
            <span>{topic.submitter}</span>
            <span>{netaDate(topic.createdAt)}</span>
          </div>
          <NetaTopicAdmin topicId={topic.id} featured={topic.featured} afterDelete={week && !week.isActive ? `/neta/w/${week.id}` : "/neta"} />
        </div>
        <NetaVote topicId={topic.id} stars={topic.stars} voted={voted} />
      </div>
      <div className={s.topicBox}>
        {topic.description ? <p className={s.topicDesc}>{topic.description}</p> : <p className={s.topicDesc}>（説明なし）</p>}
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
      <NetaFooter />
    </main>
    </NetaProvider>
  );
}
