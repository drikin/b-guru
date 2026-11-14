/* 📝 ネタ帳の 1 週分（B-guru の中のメインの列に出す用）。誰でも読める。メールアドレスは返さない。
 * ?week=<id>（なければ今週）&sort=stars|new */
import { NextRequest, NextResponse } from "next/server";
import { countTopics, getCurrentWeek, getWeek, listTopics, listWeeks, netaSort } from "@/lib/neta-board";
import { votedTopicIds } from "@/lib/neta-write";
import { viewerForClient } from "@/lib/neta-auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sort = netaSort(sp.get("sort") ?? undefined);
  const raw = sp.get("week");
  const weekId = raw && /^\d{1,9}$/.test(raw) ? Number(raw) : null;
  const [current, me] = await Promise.all([getCurrentWeek(), viewerForClient()]);
  const week = weekId == null ? current : await getWeek(weekId);
  if (!week) return NextResponse.json({ week: null, current, weeks: [], topics: [], total: 0, ...me.client }, { status: weekId == null ? 200 : 404 });
  const [topics, total, weeks] = await Promise.all([listTopics(week.id, sort), countTopics(week.id), listWeeks()]);
  const voted = await votedTopicIds(me.memberId, topics.map((t) => t.id));
  return NextResponse.json(
    { week, current, weeks, total, sort, topics: topics.map((t) => ({ ...t, voted: voted.has(t.id) })), ...me.client },
    { headers: { "Cache-Control": "no-store" } }
  );
}
