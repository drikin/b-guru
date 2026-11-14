/* 📝 ネタ 1 つ（説明・コメント。B-guru の中のメインの列に出す用）。誰でも読める。メールアドレスは返さない。 */
import { NextRequest, NextResponse } from "next/server";
import { getTopic } from "@/lib/neta-board";
import { votedTopicIds } from "@/lib/neta-write";
import { viewerForClient } from "@/lib/neta-auth";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const raw = (await params).id;
  const id = /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
  const [got, me] = await Promise.all([getTopic(id), viewerForClient()]);
  if (!got) return NextResponse.json({ error: "ネタが見つかりません" }, { status: 404 });
  const voted = (await votedTopicIds(me.memberId, [got.topic.id])).has(got.topic.id);
  return NextResponse.json({ ...got, voted, ...me.client }, { headers: { "Cache-Control": "no-store" } });
}
