import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { savePushSubscription, deletePushSubscription } from "@/lib/push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_CACHE = { "Cache-Control": "no-store, no-cache, must-revalidate" };

// POST /api/push/subscribe — body: { endpoint, keys: { p256dh, auth }, userAgent? }
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; userAgent?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  const p256dh = typeof body.keys?.p256dh === "string" ? body.keys.p256dh.trim() : "";
  const auth = typeof body.keys?.auth === "string" ? body.keys.auth.trim() : "";

  if (!endpoint || !p256dh || !auth) {
    return NextResponse.json({ error: "購読情報が不正です" }, { status: 400 });
  }
  if (!endpoint.startsWith("https://") && !endpoint.startsWith("http://localhost")) {
    return NextResponse.json({ error: "不正なエンドポイントです" }, { status: 400 });
  }

  const userAgent = typeof body.userAgent === "string" ? body.userAgent.slice(0, 500) : null;

  try {
    await savePushSubscription(email, endpoint, p256dh, auth, userAgent);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("push subscribe:", e.message);
    return NextResponse.json({ error: "保存に失敗しました" }, { status: 500 });
  }
}

// DELETE /api/push/subscribe — body: { endpoint }
export async function DELETE(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  let body: { endpoint?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "不正なリクエストです" }, { status: 400 });
  }

  const endpoint = typeof body.endpoint === "string" ? body.endpoint.trim() : "";
  if (!endpoint) return NextResponse.json({ error: "エンドポイントが必要です" }, { status: 400 });

  try {
    await deletePushSubscription(email, endpoint);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e: any) {
    console.error("push unsubscribe:", e.message);
    return NextResponse.json({ error: "削除に失敗しました" }, { status: 500 });
  }
}
