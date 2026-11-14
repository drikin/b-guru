/* 📝 neta.backspace.fm の POST /api/topics の互換の受け口（昔の Chrome 拡張がそのまま使えるように）。
 * 切り替えの日に neta.backspace.fm の nginx がこの URL へ送る（docs/neta-cutover.md）。
 * ログインなし・cookie は見ない（よそのページから押させても、その人の何かを使うことはない）。答えの形はネタ帳と同じ。 */
import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { createTopicFromExtension, NetaError, netaLive } from "@/lib/neta-write";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!netaLive()) return NextResponse.json({ message: "まだ受け付けていません" }, { status: 503 });
  let body: Record<string, unknown> = {};
  try {
    const b = await req.json();
    if (b && typeof b === "object" && !Array.isArray(b)) body = b;
  } catch {
    return NextResponse.json({ message: "Invalid JSON" }, { status: 400 });
  }
  try {
    const { id } = await createTopicFromExtension(clientIp(req), body);
    return NextResponse.json({ id, url: `https://bsm.backspace.fm/neta/t/${id}` }, { status: 201 });
  } catch (e) {
    if (e instanceof NetaError) {
      if (e.code === "duplicate") {
        return NextResponse.json({ message: e.message, code: "DUPLICATE_URL", existingTopic: e.extra.existing }, { status: 409 });
      }
      return NextResponse.json({ message: e.message }, { status: e.status });
    }
    console.error("[neta:compat]", (e as Error)?.message);
    return NextResponse.json({ message: "Failed to create topic" }, { status: 500 });
  }
}
