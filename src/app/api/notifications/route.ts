import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/notifications — list + unread count for the current user
export async function GET() {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  try {
    const [notifications, unreadCount] = await Promise.all([
      listNotifications(email),
      countUnreadNotifications(email),
    ]);
    return NextResponse.json({ notifications, unreadCount });
  } catch (e: any) {
    console.error("notifications GET:", e.message);
    return NextResponse.json({ error: "取得失敗" }, { status: 500 });
  }
}

// POST /api/notifications — body: { id?: number, all?: true }
// Marks one notification (id) or all (all:true) as read.
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) return NextResponse.json({ error: "ログインが必要です" }, { status: 401 });

  let body: { id?: unknown; all?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストが不正です" }, { status: 400 });
  }

  try {
    if (body.all === true) {
      const updated = await markAllNotificationsRead(email);
      return NextResponse.json({ ok: true, updated });
    }
    if (typeof body.id === "number" && body.id > 0) {
      const marked = await markNotificationRead(body.id, email);
      return NextResponse.json({ ok: true, marked });
    }
    return NextResponse.json({ error: "id または all が必要です" }, { status: 400 });
  } catch (e: any) {
    console.error("notifications POST:", e.message);
    return NextResponse.json({ error: "更新失敗" }, { status: 500 });
  }
}
