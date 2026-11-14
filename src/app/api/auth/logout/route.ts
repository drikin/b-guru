import { NextResponse } from "next/server";
import { destroySession } from "@/lib/session";
import { endNetaSession } from "@/lib/neta-auth";

export const dynamic = "force-dynamic";

export async function POST() {
  await destroySession();
  // ログインは 1 つ（ネタ帳のログインで B-guru にも入る）なので、ネタ帳のログインも一緒に切る（共用の PC で残らないように）。
  await endNetaSession().catch(() => {});
  return NextResponse.json({ ok: true });
}
